import type { Signal } from "../analysis/signal";

/**
 * Target monitoring on live marks. LONG TPs trigger at/above target,
 * SHORT at/below. Documented tick handling: marks are mid-price ticks —
 * fast wicks can pass between ticks, so candle high/low ranges (journal
 * outcomes) remain the conservative record and tick hits are the fast path.
 */

export type TargetLevel = "ENTRY" | "TP1" | "TP2" | "TP3" | "INVALIDATION";

export function checkTargets(
  signal: Pick<Signal, "direction" | "entryLow" | "entryHigh" | "invalidation" | "tp1" | "tp2" | "tp3">,
  markPrice: number,
): TargetLevel[] {
  if (!Number.isFinite(markPrice) || markPrice <= 0) return [];
  const hit: TargetLevel[] = [];
  if (signal.direction === "LONG") {
    if (signal.entryLow !== null && signal.entryHigh !== null && markPrice >= signal.entryLow && markPrice <= signal.entryHigh) {
      hit.push("ENTRY");
    }
    if (signal.tp1 !== null && markPrice >= signal.tp1) hit.push("TP1");
    if (signal.tp2 !== null && markPrice >= signal.tp2) hit.push("TP2");
    if (signal.tp3 !== null && markPrice >= signal.tp3) hit.push("TP3");
    if (signal.invalidation !== null && markPrice <= signal.invalidation) hit.push("INVALIDATION");
  } else if (signal.direction === "SHORT") {
    if (signal.entryLow !== null && signal.entryHigh !== null && markPrice >= signal.entryLow && markPrice <= signal.entryHigh) {
      hit.push("ENTRY");
    }
    if (signal.tp1 !== null && markPrice <= signal.tp1) hit.push("TP1");
    if (signal.tp2 !== null && markPrice <= signal.tp2) hit.push("TP2");
    if (signal.tp3 !== null && markPrice <= signal.tp3) hit.push("TP3");
    if (signal.invalidation !== null && markPrice >= signal.invalidation) hit.push("INVALIDATION");
  }
  return hit;
}
