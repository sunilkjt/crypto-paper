/**
 * Headless signal-outcome resolver for GitHub Actions schedule.
 *
 * Reads unresolved signal_history rows (outcome IS NULL), replays the
 * post-signal candles with the same conservative thirds rules as paper
 * trading, and writes terminal verdicts back (WIN/LOSS/BREAKEVEN/EXPIRED/
 * UNKNOWN + outcome_at/exit_price/realized_r/resolved_at).
 *
 * Read-only toward strategy: no scoring, no thresholds, no notifications,
 * no AI, no cron-state touches. Resolved rows are never rewritten.
 * OPEN rows stay NULL (transient) for the next run.
 *
 * Requires migration 0008_signal_outcomes.sql applied first — preflight
 * aborts with a clear message when the outcome columns are missing.
 *
 * Reads server-side env only (never VITE_*); exits non-zero on fatal or
 * total failure. Usage: npm run resolve:outcomes
 */

import { getCachedCandles } from "../src/market/hyperliquid/index.js";
import type { Timeframe } from "../src/market/hyperliquid/types.js";
import { alreadyResolved, decideRowAction, planOf } from "../src/analytics/resolve.js";
import { createSupabaseStateStore } from "../src/cron/state.js";

function required(name: string): string {
  const v = (process.env[name] ?? "").trim();
  if (!v) {
    console.error(`Missing required env ${name}.`);
    process.exit(2);
  }
  return v;
}

const SUPPORTED_TF = new Set(["5m", "15m", "1h", "4h"]);

interface UnresolvedRow {
  id: string;
  symbol: string;
  direction: "LONG" | "SHORT";
  timeframe: string;
  entry_low: number | null;
  entry_high: number | null;
  invalidation: number | null;
  tp1: number | null;
  tp2: number | null;
  tp3: number | null;
  first_seen: string;
}

async function boundedAll<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const out: T[] = new Array(tasks.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < tasks.length) {
      const i = next++;
      out[i] = await tasks[i]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, () => worker()));
  return out;
}

async function main(): Promise<void> {
  const supabaseUrl = required("SUPABASE_URL").replace(/\/$/, "");
  const serviceKey = required("SUPABASE_SERVICE_ROLE_KEY");
  const limit = Math.max(1, Number(process.env.RESOLVE_LIMIT ?? "200") || 200);
  const concurrency = Math.max(1, Number(process.env.RESOLVE_CONCURRENCY ?? "4") || 4);
  const lifetimeMs = Math.max(3_600_000, (Number(process.env.OUTCOME_LIFETIME_HOURS ?? "24") || 24) * 3_600_000);
  const log = (msg: string) => console.log(`[resolve-outcomes] ${msg}`);
  const headers = {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    "Content-Type": "application/json",
  };
  const now = Date.now();

  // Preflight: fail fast with a clear message when migration 0008 is missing.
  try {
    const probe = await fetch(
      `${supabaseUrl}/rest/v1/signal_history?select=id&outcome=is.null&limit=1`,
      { headers, signal: AbortSignal.timeout(15_000) },
    );
    if (probe.status === 400) {
      console.error("[resolve-outcomes] signal_history has no outcome columns — apply migration 0008_signal_outcomes.sql first.");
      process.exit(1);
    }
    if (!probe.ok) {
      console.error(`[resolve-outcomes] preflight failed (HTTP ${probe.status}).`);
      process.exit(1);
    }
  } catch (e) {
    console.error(`[resolve-outcomes] preflight failed: ${e instanceof Error ? e.message : "unknown"}`);
    process.exit(1);
  }

  let rows: UnresolvedRow[];
  try {
    const res = await fetch(
      `${supabaseUrl}/rest/v1/signal_history?outcome=is.null&select=id,symbol,direction,timeframe,entry_low,entry_high,invalidation,tp1,tp2,tp3,first_seen&order=first_seen.asc&limit=${limit}`,
      { headers, signal: AbortSignal.timeout(30_000) },
    );
    if (!res.ok) {
      console.error(`[resolve-outcomes] list failed (HTTP ${res.status}).`);
      process.exit(1);
    }
    rows = (await res.json()) as UnresolvedRow[];
  } catch (e) {
    console.error(`[resolve-outcomes] list failed: ${e instanceof Error ? e.message : "unknown"}`);
    process.exit(1);
  }
  if (rows.length === 0) {
    log("nothing unresolved — done");
  } else {
    log(`${rows.length} unresolved rows`);
  }

  let resolved = 0;
  let skippedOpen = 0;
  let failed = 0;

  // Heartbeat for /status + diagnostics. Separate scanner_state key —
  // cron-monitor is never touched. Always written, even when there was
  // nothing to resolve, so "never reported" unambiguously means the job
  // has not run (not "ran with zero work"). Best-effort: a failed
  // heartbeat never fails the run.
  const writeHeartbeat = async (): Promise<void> => {
    try {
      const store = createSupabaseStateStore({ url: supabaseUrl, serviceKey });
      await store.saveValue("resolve-outcomes", {
        at: Date.now(),
        checked: rows.length,
        resolved,
        skippedOpen,
        failed,
      });
    } catch (e) {
      log(`heartbeat skipped: ${e instanceof Error ? e.message : "unknown"}`);
    }
  };

  const patch = async (id: string, body: Record<string, unknown>): Promise<boolean> => {
    try {
      const res = await fetch(`${supabaseUrl}/rest/v1/signal_history?id=eq.${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ ...body, resolved_at: new Date().toISOString() }),
        signal: AbortSignal.timeout(15_000),
      });
      return res.ok;
    } catch {
      return false;
    }
  };

  await boundedAll(
    rows.map((row) => async () => {
      try {
        // Belt-and-braces idempotency: the list query already filters
        // outcome IS NULL, but a row resolved between listing and here
        // must never be rewritten.
        if (alreadyResolved((row as { outcome?: unknown }).outcome)) return;
        const plan = planOf({ ...row, outcome: null });
        if (plan === null) {
          // Unmeasurable plan: terminal UNKNOWN (never retried forever).
          if (await patch(row.id, { outcome: "UNKNOWN", outcome_at: null, exit_price: null, realized_r: null, decided_by: "UNKNOWN" })) {
            resolved += 1;
          } else {
            failed += 1;
          }
          return;
        }
        const tf = (SUPPORTED_TF.has(row.timeframe) ? row.timeframe : "15m") as Timeframe;
        const end = Math.min(plan.firstSeen + lifetimeMs, now);
        let candles: Awaited<ReturnType<typeof getCachedCandles>>["candles"] = [];
        try {
          const res = await getCachedCandles(row.symbol, tf, plan.firstSeen, end);
          candles = res.candles.filter((c) => c.timestamp > plan.firstSeen);
        } catch {
          candles = [];
        }
        const decision = decideRowAction(plan, candles, now, lifetimeMs);
        if (decision.action === "none") return;
        if (decision.action === "skip") {
          skippedOpen += 1; // transient — retry next run
          return;
        }
        if (await patch(row.id, decision.patch)) {
          resolved += 1;
        } else {
          failed += 1;
        }
      } catch {
        failed += 1;
      }
    }),
    concurrency,
  );

  log(`done: resolved=${resolved} open-skipped=${skippedOpen} failed=${failed}`);
  await writeHeartbeat();
  if (rows.length > 0 && resolved === 0 && failed === rows.length) {
    console.error("[resolve-outcomes] every row failed");
    process.exit(1);
  }
}

main().catch((e: unknown) => {
  console.error(`[resolve-outcomes] fatal: ${e instanceof Error ? e.message : "unknown"}`);
  process.exit(1);
});
