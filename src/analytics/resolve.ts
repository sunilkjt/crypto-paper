import type { Candle } from "../market/hyperliquid/types";
import { replayThirds, type ReplayResult, type SignalVerdict } from "./performance";

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
  entry_type: string | null;
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
  /** Engine entry type (null = legacy row → immediate measurement). */
  entryType: "MARKET" | "RETEST" | null;
  entryLow: number;
  entryHigh: number;
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
  if (typeof row.entry_low !== "number" || typeof row.entry_high !== "number" || !(row.entry_high > row.entry_low)) return null;
  const entryType =
    row.entry_type === "MARKET" || row.entry_type === "RETEST" ? row.entry_type : null;
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
    entryType,
    entryLow: row.entry_low,
    entryHigh: row.entry_high,
  };
}

export interface ResolvePatch {
  outcome: SignalVerdict;
  outcome_at: string | null;
  exit_price: number | null;
  realized_r: number | null;
  decided_by: string;
  activation_price: number | null;
  activation_at: string | null;
  ambiguous: boolean;
}

export type RowDecision =
  | { action: "none" }
  | { action: "skip" }
  | {
      action: "resolve";
      patch: ResolvePatch;
      /** Unresolved same-bar conflict for a finer-TF second pass (null when decided). */
      ambiguousBar: { barOpen: number; barClose: number; target: number } | null;
    };

const toIso = (ms: number | null): string | null =>
  ms === null || !Number.isFinite(ms) ? null : new Date(ms).toISOString();

function terminalPatch(
  r: Pick<ReplayResult, "verdict" | "realizedR" | "exitPrice" | "outcomeAt" | "decidedBy" | "activationPrice" | "activationTs" | "ambiguous">,
): ResolvePatch {
  return {
    outcome: r.verdict,
    outcome_at: toIso(r.outcomeAt),
    exit_price: r.exitPrice,
    realized_r: r.realizedR,
    decided_by: r.decidedBy,
    activation_price: r.activationPrice,
    activation_at: toIso(r.activationTs),
    ambiguous: r.ambiguous,
  };
}

/**
 * Decide one row given its validated plan and already-fetched candles.
 * Candles at or before the signal timestamp are stale for this purpose
 * and ignored (the replay engine enforces the same boundary).
 * Legacy rows without an entry type measure immediately (historical
 * behavior preserved); RETEST rows require a zone touch first.
 */
export function decideRowAction(
  plan: ResolvablePlan,
  candles: Candle[],
  now: number,
  lifetimeMs: number,
  finer?: Candle[],
): RowDecision {
  if (candles.length === 0) {
    return now - plan.firstSeen >= lifetimeMs
      ? {
          action: "resolve",
          patch: {
            outcome: "UNKNOWN",
            outcome_at: null,
            exit_price: null,
            realized_r: null,
            decided_by: "UNKNOWN",
            activation_price: null,
            activation_at: null,
            ambiguous: false,
          },
          ambiguousBar: null,
        }
      : { action: "skip" };
  }
  const immediate = plan.entryType !== "RETEST";
  const r = replayThirds({
    direction: plan.direction,
    entryMid: plan.entryMid,
    risk: plan.risk,
    invalidation: plan.invalidation,
    tp1: plan.tp1,
    tp2: plan.tp2,
    tp3: plan.tp3,
    entryLow: plan.entryLow,
    entryHigh: plan.entryHigh,
    immediate,
    followCandles: candles,
    signalTs: plan.firstSeen,
    maxLifetimeMs: lifetimeMs,
    finer,
  });
  if (r.verdict === "OPEN" || r.verdict === "UNKNOWN") return { action: "skip" };
  return {
    action: "resolve",
    patch: terminalPatch(r),
    ambiguousBar: r.ambiguousBar
      ? { barOpen: r.ambiguousBar.barOpen, barClose: r.ambiguousBar.barClose, target: r.ambiguousBar.target }
      : null,
  };
}
