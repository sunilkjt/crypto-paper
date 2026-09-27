import type { Candle } from "../market/hyperliquid/types";

/**
 * Outcome tracking on observed candles — no orders, no PnL claims.
 * Reports which levels the market actually touched after the signal bar:
 * TP1/TP2/TP3, invalidation, max favorable/adverse excursion (in R),
 * and time to first TP1 touch / invalidation touch. Excursions measured
 * from entry mid in units of initial risk. "Reached" means touched.
 */

export interface OutcomeInput {
  direction: "LONG" | "SHORT";
  entryMid: number;
  risk: number;
  invalidation: number;
  tp1: number;
  tp2: number;
  tp3: number;
  /** Candles strictly AFTER the signal bar, oldest first. */
  followCandles: Candle[];
}

export interface Outcome {
  tp1Reached: boolean;
  tp2Reached: boolean;
  tp3Reached: boolean;
  invalidationReached: boolean;
  /** Max favorable excursion in R multiples. */
  mfeR: number;
  /** Max adverse excursion in R multiples (≤ 0). */
  maeR: number;
  /** Ms from signal to first TP1 touch (null if untouched). */
  timeToTp1Ms: number | null;
  /** Ms from signal to first invalidation touch (null if untouched). */
  timeToInvalidationMs: number | null;
  barsObserved: number;
}

export function trackOutcome(input: OutcomeInput): Outcome {
  const { direction, entryMid, risk, invalidation, tp1, tp2, tp3, followCandles } = input;
  const out: Outcome = {
    tp1Reached: false,
    tp2Reached: false,
    tp3Reached: false,
    invalidationReached: false,
    mfeR: 0,
    maeR: 0,
    timeToTp1Ms: null,
    timeToInvalidationMs: null,
    barsObserved: followCandles.length,
  };
  if (!(risk > 0) || followCandles.length === 0) return out;
  const t0 = followCandles[0].timestamp;
  const isLong = direction === "LONG";

  for (const c of followCandles) {
    const fav = isLong ? c.high - entryMid : entryMid - c.low;
    const adv = isLong ? entryMid - c.low : c.high - entryMid;
    out.mfeR = Math.max(out.mfeR, fav / risk);
    out.maeR = Math.min(out.maeR, -adv / risk);

    const touch = (level: number) =>
      isLong ? c.high >= level : c.low <= level;
    const touchInv = isLong ? c.low <= invalidation : c.high >= invalidation;

    if (!out.tp1Reached && touch(tp1)) {
      out.tp1Reached = true;
      out.timeToTp1Ms = c.timestamp - t0;
    }
    if (!out.tp2Reached && touch(tp2)) out.tp2Reached = true;
    if (!out.tp3Reached && touch(tp3)) out.tp3Reached = true;
    if (!out.invalidationReached && touchInv) {
      out.invalidationReached = true;
      out.timeToInvalidationMs = c.timestamp - t0;
    }
  }
  out.mfeR = Math.round(out.mfeR * 100) / 100;
  out.maeR = Math.round(out.maeR * 100) / 100;
  return out;
}
