import type { MomentumResult } from "./momentum";
import type { StructureResult } from "./structure";
import type { VolumeResult } from "./volumeProfile";
import type { LevelsResult } from "./levels";
import type { MtfResult } from "./mtf";

/**
 * Dedicated bounce detector. A bounce is a multi-confirmation event —
 * oversold alone is never enough. LONG requires: price near meaningful
 * support, RSI weakness-then-recovery, improving MACD, volume
 * confirmation, a lower-timeframe turn, and a higher timeframe that is
 * not strongly bearish. SHORT mirrors the conditions.
 */

export interface BounceInput {
  price: number;
  atr: number;
  momentum: MomentumResult;
  structure: StructureResult;
  volume: VolumeResult;
  levels: LevelsResult;
  mtf: MtfResult;
  /** Distance to nearest support in ATR multiples (null = none nearby). */
  supportDistanceAtr: number | null;
  /** Distance to nearest resistance in ATR multiples. */
  resistanceDistanceAtr: number | null;
}

export interface BounceResult {
  direction: "LONG" | "SHORT" | null;
  /** 0..100 checklist score. */
  bounceScore: number;
  bounceReasons: string[];
  bounceWarnings: string[];
  /** Transparent sub-scores (sum to the pre-cap total). */
  components: BounceComponents;
}

export interface BounceComponents {
  /** Location at the level, 0..25. */
  support: number;
  /** RSI recovery + MACD improvement, 0..35. */
  momentum: number;
  /** Volume confirmation, 0..15. */
  volume: number;
  /** Structure agreement bonus, 0..5. */
  structure: number;
  /** Lower-TF turn + higher-TF guard, 0..25. */
  mtf: number;
}

const EMPTY_COMPONENTS: BounceComponents = { support: 0, momentum: 0, volume: 0, structure: 0, mtf: 0 };

/** Scale buckets proportionally so displayed parts sum to a capped total. */
function scaleBuckets(b: BounceComponents, targetTotal: number): void {
  const sum = b.support + b.momentum + b.volume + b.structure + b.mtf;
  if (sum <= 0) return;
  const f = Math.min(1, targetTotal / sum);
  b.support = Math.round(b.support * f * 10) / 10;
  b.momentum = Math.round(b.momentum * f * 10) / 10;
  b.volume = Math.round(b.volume * f * 10) / 10;
  b.structure = Math.round(b.structure * f * 10) / 10;
  b.mtf = Math.round(b.mtf * f * 10) / 10;
}

const NEAR_LEVEL_ATR = 1.0;

export function detectBounce(input: BounceInput): BounceResult {
  const reasons: string[] = [];
  const warnings: string[] = [];
  let longPts = 0;
  let shortPts = 0;
  // Per-bucket mirrors of the totals above (same weights, named buckets).
  const longB: BounceComponents = { ...EMPTY_COMPONENTS };
  const shortB: BounceComponents = { ...EMPTY_COMPONENTS };
  const finish = (
    direction: "LONG" | "SHORT" | null,
    score: number,
    b: BounceComponents,
  ): BounceResult => ({ direction, bounceScore: score, bounceReasons: reasons, bounceWarnings: warnings, components: { ...b } });

  // 1. Location: near meaningful support / resistance (25).
  const nearSupport =
    input.supportDistanceAtr !== null && input.supportDistanceAtr <= NEAR_LEVEL_ATR;
  const nearResistance =
    input.resistanceDistanceAtr !== null && input.resistanceDistanceAtr <= NEAR_LEVEL_ATR;
  if (nearSupport) {
    longPts += 25;
    longB.support += 25;
    reasons.push(`Holding near support (${input.supportDistanceAtr?.toFixed(2)} ATR away).`);
  } else {
    warnings.push("Price is not near a meaningful support — no LONG bounce.");
  }
  if (nearResistance) {
    shortPts += 25;
    shortB.support += 25;
    reasons.push(`Rejecting near resistance (${input.resistanceDistanceAtr?.toFixed(2)} ATR away).`);
  } else {
    warnings.push("Price is not near a meaningful resistance — no SHORT bounce.");
  }

  // 2. RSI weakness-then-recovery, never oversold-alone (20).
  if (input.momentum.recovering) {
    longPts += 20;
    longB.momentum += 20;
    reasons.push("RSI recovering after weakness (not blindly oversold).");
  }
  if (input.momentum.fading) {
    shortPts += 20;
    shortB.momentum += 20;
    reasons.push("RSI fading after strength (not blindly overbought).");
  }

  // 3. MACD improving (15).
  if (input.momentum.longScore >= 0.5) {
    longPts += 15;
    longB.momentum += 15;
    reasons.push("MACD momentum improving on the setup timeframe.");
  }
  if (input.momentum.shortScore >= 0.5) {
    shortPts += 15;
    shortB.momentum += 15;
    reasons.push("MACD momentum deteriorating on the setup timeframe.");
  }

  // 4. Volume confirmation (15).
  if (input.volume.score >= 0.5) {
    longPts += nearSupport ? 15 : 5;
    longB.volume += nearSupport ? 15 : 5;
    shortPts += nearResistance ? 15 : 5;
    shortB.volume += nearResistance ? 15 : 5;
    if (input.volume.spike) reasons.push("Volume spike confirms interest at the level.");
    else reasons.push("Healthy volume backs the move.");
  } else {
    warnings.push("Low volume — any bounce lacks confirmation.");
  }

  // 5. Lower-timeframe turn via MTF entry flavor (15).
  const m5 = input.mtf.tfs.find((t) => t.timeframe === "5m");
  if (m5?.flavor === "BULLISH_REVERSAL" || m5?.flavor === "CONTINUATION") {
    longPts += 15;
    longB.mtf += 15;
    reasons.push(`Lower timeframe confirms (${m5.flavor}).`);
  }
  if (m5?.flavor === "BEARISH_REVERSAL" || m5?.flavor === "BEARISH") {
    shortPts += 15;
    shortB.mtf += 15;
    reasons.push(`Lower timeframe confirms (${m5.flavor}).`);
  }

  // 6. Higher-timeframe guard (10): veto only, never award alone.
  const h4 = input.mtf.tfs.find((t) => t.timeframe === "4h");
  const h4Agreement = h4?.agreement ?? 0;
  if (h4Agreement > -0.6) {
    longPts += 10;
    longB.mtf += 10;
  } else {
    warnings.push("Higher timeframe strongly bearish — LONG bounce vetoed.");
    longPts = Math.min(longPts, 30);
    scaleBuckets(longB, longPts);
  }
  if (h4Agreement < 0.6) {
    shortPts += 10;
    shortB.mtf += 10;
  } else {
    warnings.push("Higher timeframe strongly bullish — SHORT bounce vetoed.");
    shortPts = Math.min(shortPts, 30);
    scaleBuckets(shortB, shortPts);
  }

  // Structure agreement bonus (capped at 100 below).
  if (input.structure.label === "BULLISH" && nearSupport) {
    longPts += 5;
    longB.structure += 5;
    reasons.push("Market structure is bullish (HH/HL).");
  }
  if (input.structure.label === "BEARISH" && nearResistance) {
    shortPts += 5;
    shortB.structure += 5;
    reasons.push("Market structure is bearish (LH/LL).");
  }

  longPts = Math.min(100, longPts);
  shortPts = Math.min(100, shortPts);

  if (longPts >= shortPts && longPts >= 60 && nearSupport) {
    return finish("LONG", longPts, longB);
  }
  if (shortPts > longPts && shortPts >= 60 && nearResistance) {
    return finish("SHORT", shortPts, shortB);
  }
  return finish(null, Math.max(longPts, shortPts), longPts >= shortPts ? longB : shortB);
}
