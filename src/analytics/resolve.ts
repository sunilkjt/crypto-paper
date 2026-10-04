import type { Candle } from "../market/hyperliquid/types";
import { replayThirds, type SignalVerdict } from "./performance";

/**
 * Pure per-row outcome decision for the resolver job. No network, no clock
 * reads (now/lifetime injected), never mutates inputs — the script is a
 * thin IO shell around this. Idempotency falls out structurally:
 * already-resolved rows yield "none", and re-running a resolution over
 * unchanged candles yields the identical patch.
 */

export interface UnresolvedRowLike {
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
  outcome: string | null;
}

export interface ResolvablePlan {
  id: string;
  symbol: string;
  direction: "LONG" | "SHORT";
  timeframe: string;
  entryMid: number;
  risk: number;
  invalidation: number;
  tp1: number;
  tp2: number;
  tp3: number;
  firstSeen: number;
}

/** True when the row already carries a terminal verdict (never rewrite). */
export function alreadyResolved(outcome: unknown): boolean {
  return (
    outcome === "WIN" ||
    outcome === "LOSS" ||
    outcome === "BREAKEVEN" ||
    outcome === "EXPIRED" ||
    outcome === "UNKNOWN"
  );
}

/**
 * Validate a row's trade plan. Null = unmeasurable (caller writes terminal
 * UNKNOWN without fetching candles). Entry mid + risk use the same
 * definitions as the replay engine.
 */
export function planOf(row: UnresolvedRowLike): ResolvablePlan | null {
  const firstSeen = Date.parse(row.first_seen);
  if (!Number.isFinite(firstSeen)) return null;
  if (typeof row.entry_low !== "number" || typeof row.entry_high !== "number") return null;
  const entryMid = (row.entry_low + row.entry_high) / 2;
  if (!(entryMid > 0)) return null;
  if (typeof row.invalidation !== "number") return null;
  const isLong = row.direction === "LONG";
  const risk = isLong ? entryMid - row.invalidation : row.invalidation - entryMid;
  if (!(risk > 0)) return null;
  if (typeof row.tp1 !== "number" || typeof row.tp2 !== "number" || typeof row.tp3 !== "number") return null;
  return {
    id: row.id,
    symbol: row.symbol,
    direction: row.direction,
    timeframe: row.timeframe,
    entryMid,
    risk,
    invalidation: row.invalidation,
    tp1: row.tp1,
    tp2: row.tp2,
    tp3: row.tp3,
    firstSeen,
  };
}

export interface ResolvePatch {
  outcome: SignalVerdict;
  outcome_at: string | null;
  exit_price: number | null;
  realized_r: number | null;
  decided_by: string;
}

export type RowDecision =
  | { action: "none" }
  | { action: "skip" }
  | { action: "resolve"; patch: ResolvePatch };

const toIso = (ms: number | null): string | null =>
  ms === null || !Number.isFinite(ms) ? null : new Date(ms).toISOString();

/**
 * Decide one row given its validated plan and already-fetched candles.
 * Candles at or before the signal timestamp are stale for this purpose
 * and ignored (the replay engine enforces the same boundary).
 */
export function decideRowAction(
  plan: ResolvablePlan,
  candles: Candle[],
  now: number,
  lifetimeMs: number,
): RowDecision {
  if (candles.length === 0) {
    return now - plan.firstSeen >= lifetimeMs
      ? {
          action: "resolve",
          patch: { outcome: "UNKNOWN", outcome_at: null, exit_price: null, realized_r: null, decided_by: "UNKNOWN" },
        }
      : { action: "skip" };
  }
  const r = replayThirds({
    direction: plan.direction,
    entryMid: plan.entryMid,
    risk: plan.risk,
    invalidation: plan.invalidation,
    tp1: plan.tp1,
    tp2: plan.tp2,
    tp3: plan.tp3,
    followCandles: candles,
    signalTs: plan.firstSeen,
    maxLifetimeMs: lifetimeMs,
  });
  if (r.verdict === "OPEN" || r.verdict === "UNKNOWN") return { action: "skip" };
  return {
    action: "resolve",
    patch: {
      outcome: r.verdict,
      outcome_at: toIso(r.outcomeAt),
      exit_price: r.exitPrice,
      realized_r: r.realizedR,
      decided_by: r.decidedBy,
    },
  };
}
