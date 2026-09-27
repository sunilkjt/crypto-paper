/**
 * Transparent 100-point signal scoring. Weights: Trend 25, Momentum 20,
 * Volume 15, Market Structure 20, Multi-Timeframe 20. LONG and SHORT are
 * scored independently from mirrored evidence; the stronger side wins only
 * with a clear edge, otherwise WAIT. Scores are Signal Strength 0–100 —
 * NEVER described as probability.
 */

export type Direction = "LONG" | "SHORT" | "WAIT";

export type StrengthClass =
  | "WAIT"
  | "WATCH"
  | "SETUP"
  | "STRONG SETUP"
  | "HIGH-CONFLUENCE SETUP";

export interface ScoreComponents {
  /** 0..25 */
  trend: number;
  /** 0..20 */
  momentum: number;
  /** 0..15 */
  volume: number;
  /** 0..20 */
  structure: number;
  /** 0..20 */
  mtf: number;
}

export interface ScoringInput {
  trendLong: number;
  trendShort: number;
  momentumLong: number;
  momentumShort: number;
  /** Direction-agnostic 0..1 volume confirmation. */
  volume: number;
  structureLong: number;
  structureShort: number;
  mtfLong: number;
  mtfShort: number;
}

export interface ScoreResult {
  longScore: number;
  shortScore: number;
  score: number;
  direction: Direction;
  classification: StrengthClass;
  /** Winning side's component breakdown (zeros when WAIT). */
  components: ScoreComponents;
  reasons: string[];
  warnings: string[];
}

export const MIN_EDGE = 10;
export const MIN_SCORE = 40;

export function classifyStrength(score: number): StrengthClass {
  if (score >= 90) return "HIGH-CONFLUENCE SETUP";
  if (score >= 75) return "STRONG SETUP";
  if (score >= 60) return "SETUP";
  if (score >= 40) return "WATCH";
  return "WAIT";
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

export function calculateSignalScore(input: ScoringInput): ScoreResult {
  const longC: ScoreComponents = {
    trend: clamp(input.trendLong, 0, 1) * 25,
    momentum: clamp(input.momentumLong, 0, 1) * 20,
    volume: clamp(input.volume, 0, 1) * 15,
    structure: clamp(input.structureLong, 0, 1) * 20,
    mtf: clamp(input.mtfLong, 0, 1) * 20,
  };
  const shortC: ScoreComponents = {
    trend: clamp(input.trendShort, 0, 1) * 25,
    momentum: clamp(input.momentumShort, 0, 1) * 20,
    volume: clamp(input.volume, 0, 1) * 15,
    structure: clamp(input.structureShort, 0, 1) * 20,
    mtf: clamp(input.mtfShort, 0, 1) * 20,
  };
  const longScore = round1(longC.trend + longC.momentum + longC.volume + longC.structure + longC.mtf);
  const shortScore = round1(shortC.trend + shortC.momentum + shortC.structure + shortC.mtf + shortC.volume);

  const reasons: string[] = [];
  const warnings: string[] = [];
  let direction: Direction = "WAIT";
  let score = Math.max(longScore, shortScore);
  let components: ScoreComponents = { trend: 0, momentum: 0, volume: 0, structure: 0, mtf: 0 };

  if (score < MIN_SCORE) {
    warnings.push(`Confluence too low (${score}/100) — WAIT.`);
  } else if (Math.abs(longScore - shortScore) < MIN_EDGE) {
    warnings.push(
      `Mixed evidence LONG ${longScore} vs SHORT ${shortScore} — WAIT. Never force a trade.`,
    );
  } else if (longScore > shortScore) {
    direction = "LONG";
    components = longC;
    reasons.push(`Bullish confluence ${longScore}/100 outweighs bearish ${shortScore}/100.`);
  } else {
    direction = "SHORT";
    components = shortC;
    reasons.push(`Bearish confluence ${shortScore}/100 outweighs bullish ${longScore}/100.`);
  }

  return {
    longScore,
    shortScore,
    score: round1(score),
    direction,
    classification: direction === "WAIT" ? "WAIT" : classifyStrength(score),
    components: roundComponents(components),
    reasons,
    warnings,
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function roundComponents(c: ScoreComponents): ScoreComponents {
  return {
    trend: round1(c.trend),
    momentum: round1(c.momentum),
    volume: round1(c.volume),
    structure: round1(c.structure),
    mtf: round1(c.mtf),
  };
}
