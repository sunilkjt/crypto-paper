import type { Candle, Timeframe } from "../market/hyperliquid/types";
import { getClosedCandles } from "../market/hyperliquid/timeframes";
import {
  alreadyResolved,
  decideRowAction,
  planOf,
  type ResolvePatch,
  type UnresolvedRowLike,
} from "../analytics/resolve";

/**
 * Testable core of the outcome-resolver job. All IO arrives as
 * dependencies; the only Supabase writes are per-row outcome PATCHes and
 * the `resolve-outcomes` heartbeat — cron-monitor is never touched and no
 * strategy code is reachable from here.
 *
 * Heartbeat contract (the whole point of this module): writeHeartbeat is
 * invoked on EVERY path — empty lists, per-row failures, even list
 * failures (with an error note). A missing heartbeat therefore means the
 * job itself never ran, never "ran with nothing to do".
 */

export interface ResolverHeartbeat {
  at: number;
  checked: number;
  resolved: number;
  skippedOpen: number;
  failed: number;
  error?: string;
}

export interface ResolverJobDeps {
  now: number;
  lifetimeMs: number;
  concurrency: number;
  listUnresolved: () => Promise<UnresolvedRowLike[]>;
  fetchCandles: (symbol: string, tf: Timeframe, from: number, to: number) => Promise<Candle[]>;
  patchRow: (id: string, patch: ResolvePatch) => Promise<boolean>;
  writeHeartbeat: (hb: ResolverHeartbeat) => Promise<void>;
  log?: (msg: string) => void;
}

export interface ResolverCounts {
  checked: number;
  resolved: number;
  skippedOpen: number;
  failed: number;
  /** False only when the listing itself failed (caller should exit non-zero). */
  ok: boolean;
}

const SUPPORTED_TF = new Set(["5m", "15m", "1h", "4h"]);

/** Setup TF → finer TF for ordering same-bar stop/target touches. */
export const FINER_TF: Record<string, Timeframe> = { "15m": "5m", "1h": "15m", "4h": "1h", "5m": "1m" };

export function normalizeTimeframe(tf: string): Timeframe {
  return (SUPPORTED_TF.has(tf) ? tf : "15m") as Timeframe;
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

export async function runResolverJob(deps: ResolverJobDeps): Promise<ResolverCounts> {
  const { now, lifetimeMs, concurrency } = deps;
  const log = deps.log ?? (() => {});
  const counts: ResolverCounts = { checked: 0, resolved: 0, skippedOpen: 0, failed: 0, ok: true };

  const heartbeat = async (extra?: Partial<ResolverHeartbeat>): Promise<void> => {
    try {
      await deps.writeHeartbeat({
        at: Date.now(),
        checked: counts.checked,
        resolved: counts.resolved,
        skippedOpen: counts.skippedOpen,
        failed: counts.failed,
        ...extra,
      });
    } catch (e) {
      // A failed heartbeat must never fail the run — but it must be loud.
      log(`heartbeat skipped: ${e instanceof Error ? e.message : "unknown"}`);
    }
  };

  let rows: UnresolvedRowLike[];
  try {
    rows = await deps.listUnresolved();
  } catch (e) {
    await heartbeat({ error: e instanceof Error ? e.message : "list failed" });
    return { ...counts, ok: false };
  }
  counts.checked = rows.length;
  if (rows.length === 0) {
    log("nothing unresolved — done");
    await heartbeat();
    return counts;
  }
  log(`${rows.length} unresolved rows`);

  await boundedAll(
    rows.map((row) => async () => {
      try {
        // Belt-and-braces idempotency: the listing already filters outcome
        // IS NULL, but a row resolved between listing and here must never
        // be rewritten.
        if (alreadyResolved(row.outcome)) return;
        const plan = planOf(row);
        if (plan === null) {
          // Unmeasurable plan: terminal UNKNOWN (never retried forever).
          if (
            await deps.patchRow(row.id, {
              outcome: "UNKNOWN",
              outcome_at: null,
              exit_price: null,
              realized_r: null,
              decided_by: "UNKNOWN",
              activation_price: null,
              activation_at: null,
              ambiguous: false,
            })
          ) {
            counts.resolved += 1;
          } else {
            counts.failed += 1;
          }
          return;
        }
        const tf = normalizeTimeframe(plan.timeframe);
        const end = Math.min(plan.firstSeen + lifetimeMs, now);
        let candles: Candle[] = [];
        try {
          const fetched = await deps.fetchCandles(row.symbol, tf, plan.firstSeen, end);
          // Closed candles only at the live edge: a forming wick must never
          // mint a permanent terminal verdict (verdicts are immutable).
          candles = getClosedCandles(
            fetched.filter((c) => c.timestamp > plan.firstSeen),
            tf,
            now,
          );
        } catch {
          candles = [];
        }
        const decision = decideRowAction(plan, candles, now, lifetimeMs);
        if (decision.action === "none") return;
        if (decision.action === "skip") {
          counts.skippedOpen += 1; // transient — retry next run
          return;
        }
        // Second pass: an ambiguous same-bar conflict gets one bounded
        // finer-TF lookup to establish the true touch order (genuinely
        // available market data — never fabricated intrabar order).
        let finalPatch = decision.patch;
        if (decision.ambiguousBar) {
          const finerTf = FINER_TF[plan.timeframe] ?? null;
          if (finerTf) {
            try {
              const span = decision.ambiguousBar;
              const fres = await deps.fetchCandles(row.symbol, finerTf, span.barOpen, span.barClose);
              const finer = getClosedCandles(
                fres.filter((c) => c.timestamp >= span.barOpen && c.timestamp < span.barClose),
                finerTf,
                now,
              );
              if (finer.length > 0) {
                const retry = decideRowAction(plan, candles, now, lifetimeMs, finer);
                if (retry.action === "resolve") finalPatch = retry.patch;
              }
            } catch {
              // Finer data unavailable — keep the conservative flagged result.
            }
          }
        }
        if (await deps.patchRow(row.id, finalPatch)) {
          counts.resolved += 1;
        } else {
          counts.failed += 1;
        }
      } catch {
        counts.failed += 1;
      }
    }),
    concurrency,
  );

  log(`done: resolved=${counts.resolved} open-skipped=${counts.skippedOpen} failed=${counts.failed}`);
  await heartbeat();
  return counts;
}
