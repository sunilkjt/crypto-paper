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
import { createSupabaseStateStore } from "../src/cron/state.js";
import { runResolverJob, type ResolverHeartbeat } from "../src/cron/resolveJob.js";
import type { ResolvePatch, UnresolvedRowLike } from "../src/analytics/resolve.js";
import type { Timeframe } from "../src/market/hyperliquid/types.js";

function required(name: string): string {
  const v = (process.env[name] ?? "").trim();
  if (!v) {
    console.error(`Missing required env ${name}.`);
    process.exit(2);
  }
  return v;
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
  // (A heartbeat attempt is still made below via the job only when listing
  // succeeds; a preflight failure exits red and loud by design.)
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

  const counts = await runResolverJob({
    now,
    lifetimeMs,
    concurrency,
    log,
    listUnresolved: async (): Promise<UnresolvedRowLike[]> => {
      const res = await fetch(
        `${supabaseUrl}/rest/v1/signal_history?outcome=is.null&select=id,symbol,direction,timeframe,entry_low,entry_high,entry_type,invalidation,tp1,tp2,tp3,first_seen&order=first_seen.asc&limit=${limit}`,
        { headers, signal: AbortSignal.timeout(30_000) },
      );
      if (!res.ok) throw new Error(`list failed (HTTP ${res.status})`);
      return (await res.json()) as UnresolvedRowLike[];
    },
    fetchCandles: async (symbol: string, tf: Timeframe, from: number, to: number) => {
      const res = await getCachedCandles(symbol, tf, from, to);
      return res.candles;
    },
    patchRow: async (id: string, patch: ResolvePatch): Promise<boolean> => {
      try {
        const res = await fetch(`${supabaseUrl}/rest/v1/signal_history?id=eq.${encodeURIComponent(id)}`, {
          method: "PATCH",
          headers,
          body: JSON.stringify({ ...patch, resolved_at: new Date().toISOString() }),
          signal: AbortSignal.timeout(15_000),
        });
        return res.ok;
      } catch {
        return false;
      }
    },
    writeHeartbeat: async (hb: ResolverHeartbeat): Promise<void> => {
      // Store is constructed per call (no shared mutable wiring to forget).
      const store = createSupabaseStateStore({ url: supabaseUrl, serviceKey });
      await store.saveValue("resolve-outcomes", hb);
    },
  });

  if (!counts.ok) {
    console.error("[resolve-outcomes] listing failed — see heartbeat error field");
    process.exit(1);
  }
  if (counts.checked > 0 && counts.resolved === 0 && counts.failed === counts.checked) {
    console.error("[resolve-outcomes] every row failed");
    process.exit(1);
  }
}

main().catch((e: unknown) => {
  console.error(`[resolve-outcomes] fatal: ${e instanceof Error ? e.message : "unknown"}`);
  process.exit(1);
});
