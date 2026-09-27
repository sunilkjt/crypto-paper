/**
 * Signal quality: LOW / MEDIUM / HIGH QUALITY from data quality, MTF
 * alignment, confluence, risk/reward and volatility. A high score with
 * poor risk sizing or wild volatility can never be HIGH QUALITY.
 * Strength is confluence — quality is tradability. Neither is probability.
 */

import type { Signal } from "../analysis/signal";

export type SignalQuality = "LOW QUALITY" | "MEDIUM QUALITY" | "HIGH QUALITY";

export interface QualityInput {
  strength: number;
  /** 0..1 MTF agreement on the signal side. */
  mtfAgreement: number;
  /** Conflict flag from the MTF engine. */
  mtfConflict: boolean;
  riskReward: number | null;
  /** Stop distance in ATR multiples (null = unknown). */
  riskAtr: number | null;
  /** ATR as % of price (volatility gauge, null = unknown). */
  atrPct: number | null;
  /** False-breakout flags from structure. */
  falseBreakout: boolean;
}

/** Below this R:R a plan is poor value no matter the score. */
export const MIN_RISK_REWARD = 1.5;
/** Stops wider than this are excessive distance. */
export const MAX_RISK_ATR = 4;
/** ATR above this % of price counts as wild volatility. */
export const WILD_ATR_PCT = 5;
/** Entries extended further than this from the tradable level are chasing. */
export const MAX_EXTENSION_ATR = 6;

/** Assess tradability quality directly from a scored signal. */
export function assessQuality(signal: Signal): SignalQuality {
  const mtf = signal.multiTimeframe;
  const agreement =
    mtf === null
      ? 0
      : signal.direction === "LONG"
        ? mtf.longScore
        : signal.direction === "SHORT"
          ? mtf.shortScore
          : 0;
  return classifyQuality({
    strength: signal.signalStrength,
    mtfAgreement: agreement,
    mtfConflict: mtf?.conflict ?? false,
    riskReward: signal.riskReward,
    riskAtr: signal.riskAtr,
    atrPct: signal.atrPct,
    falseBreakout: signal.falseBreakout,
  });
}

export function classifyQuality(input: QualityInput): SignalQuality {
  const { strength, mtfAgreement, mtfConflict, riskReward, riskAtr, atrPct, falseBreakout } = input;

  // Hard vetoes: poor value, excessive stop, wild volatility, trap market.
  if (riskReward === null || riskReward < MIN_RISK_REWARD) return "LOW QUALITY";
  if (riskAtr !== null && riskAtr > MAX_RISK_ATR) return "LOW QUALITY";
  if (atrPct !== null && atrPct > WILD_ATR_PCT) return "LOW QUALITY";
  if (falseBreakout) return "LOW QUALITY";

  let points = 0;
  if (strength >= 90) points += 3;
  else if (strength >= 75) points += 2;
  else if (strength >= 60) points += 1;
  if (mtfAgreement >= 0.6 && !mtfConflict) points += 2;
  else if (mtfAgreement >= 0.4) points += 1;
  if (riskReward >= 2.5) points += 2;
  else if (riskReward >= 2) points += 1;
  if (riskAtr !== null && riskAtr <= 2) points += 1;
  if (atrPct !== null && atrPct <= 2) points += 1;

  if (points >= 7) return "HIGH QUALITY";
  if (points >= 4) return "MEDIUM QUALITY";
  return "LOW QUALITY";
}
