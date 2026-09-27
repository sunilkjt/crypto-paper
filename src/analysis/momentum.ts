/**
 * Momentum classification from RSI + MACD + histogram direction.
 * Oversold/overbought levels alone NEVER decide direction — recovery
 * (RSI turning up after weakness, e.g. 28 → 35) and histogram improvement
 * carry the weight. Null inputs → null (INSUFFICIENT DATA).
 */

export type MomentumLabel =
  | "STRONG POSITIVE"
  | "POSITIVE"
  | "NEUTRAL"
  | "NEGATIVE"
  | "STRONG NEGATIVE";

export interface MomentumInput {
  rsiNow: number | null;
  /** RSI ~5 bars ago (same series). */
  rsiThen: number | null;
  /** Crossed up through 30 within the last few bars. */
  crossedUp30: boolean;
  /** Crossed down through 70 within the last few bars. */
  crossedDown70: boolean;
  histNow: number | null;
  histRising: boolean;
  histFalling: boolean;
  /** MACD line above signal line (null = unknown). */
  aboveSignal: boolean | null;
}

export interface MomentumResult {
  label: MomentumLabel;
  /** 0..1 long-side momentum. */
  longScore: number;
  /** 0..1 short-side momentum. */
  shortScore: number;
  /** RSI turning up after weakness (the 28 → 35 pattern). */
  recovering: boolean;
  /** RSI turning down after strength. */
  fading: boolean;
}

export function classifyMomentum(input: MomentumInput): MomentumResult | null {
  const { rsiNow, rsiThen, histNow } = input;
  if (
    rsiNow === null ||
    rsiThen === null ||
    histNow === null ||
    ![rsiNow, rsiThen, histNow].every(Number.isFinite)
  ) {
    return null;
  }
  const recovering =
    input.crossedUp30 || (rsiThen < 40 && rsiNow > rsiThen + 3);
  const fading =
    input.crossedDown70 || (rsiThen > 60 && rsiNow < rsiThen - 3);
  const rising = rsiNow >= rsiThen + 1;
  const falling = rsiNow <= rsiThen - 1;

  let long = 0;
  if (rsiNow > 55) long += 0.25;
  else if (rsiNow > 50) long += 0.12;
  if (recovering) long += 0.25;
  else if (rising) long += 0.12;
  if (histNow > 0) long += 0.2;
  if (input.histRising) long += 0.15;
  if (input.aboveSignal === true) long += 0.15;

  let short = 0;
  if (rsiNow < 45) short += 0.25;
  else if (rsiNow < 50) short += 0.12;
  if (fading) short += 0.25;
  else if (falling) short += 0.12;
  if (histNow < 0) short += 0.2;
  if (input.histFalling) short += 0.15;
  if (input.aboveSignal === false) short += 0.15;

  long = Math.min(1, long);
  short = Math.min(1, short);

  let label: MomentumLabel;
  if (long >= 0.7 && long - short >= 0.3) label = "STRONG POSITIVE";
  else if (short >= 0.7 && short - long >= 0.3) label = "STRONG NEGATIVE";
  else if (long - short >= 0.2) label = "POSITIVE";
  else if (short - long >= 0.2) label = "NEGATIVE";
  else label = "NEUTRAL";

  return { label, longScore: long, shortScore: short, recovering, fading };
}

/** True when the series crossed up through `level` within the last `window` bars. */
export function crossedUp(
  series: (number | null)[],
  level: number,
  window = 4,
): boolean {
  const vals = series.filter((v): v is number => v !== null).slice(-(window + 1));
  if (vals.length < 2) return false;
  for (let i = 1; i < vals.length; i++) {
    if (vals[i - 1] <= level && vals[i] > level) return true;
  }
  return false;
}

/** True when the series crossed down through `level` within the last `window` bars. */
export function crossedDown(
  series: (number | null)[],
  level: number,
  window = 4,
): boolean {
  const vals = series.filter((v): v is number => v !== null).slice(-(window + 1));
  if (vals.length < 2) return false;
  for (let i = 1; i < vals.length; i++) {
    if (vals[i - 1] >= level && vals[i] < level) return true;
  }
  return false;
}

/** True when the last `window` non-null values are monotonically rising. */
export function isRising(series: (number | null)[], window = 3): boolean {
  const vals = series.filter((v): v is number => v !== null).slice(-window);
  if (vals.length < window) return false;
  for (let i = 1; i < vals.length; i++) {
    if (vals[i] <= vals[i - 1]) return false;
  }
  return true;
}

/** True when the last `window` non-null values are monotonically falling. */
export function isFalling(series: (number | null)[], window = 3): boolean {
  const vals = series.filter((v): v is number => v !== null).slice(-window);
  if (vals.length < window) return false;
  for (let i = 1; i < vals.length; i++) {
    if (vals[i] >= vals[i - 1]) return false;
  }
  return true;
}
