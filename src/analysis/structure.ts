import type { Candle } from "../market/hyperliquid/types";
import type { Swing } from "./swings";

/**
 * Market structure from swing sequences. HH/HL → BULLISH, LH/LL → BEARISH,
 * else RANGE. Breakout/breakdown require a CLOSE beyond the level (wicks
 * don't count); a close back inside within 5 bars flags a false breakout.
 * Retest = extreme re-touched the level and held into the latest close.
 */

export type StructureLabel = "BULLISH" | "BEARISH" | "RANGE";

export interface StructureResult {
  label: StructureLabel;
  /** 0..1 long-side structure score. */
  longScore: number;
  /** 0..1 short-side structure score. */
  shortScore: number;
  brokeAbove: boolean;
  brokeBelow: boolean;
  retestHeldAbove: boolean;
  retestHeldBelow: boolean;
  falseBreakoutUp: boolean;
  falseBreakoutDown: boolean;
  lastSwingHigh: number | null;
  lastSwingLow: number | null;
}

/**
 * Kaufman-style efficiency ratio over the trailing window: net displacement
 * divided by path length. Trends approach 1, chop approaches 0. Used as a
 * regime filter so sideways flicker cannot mint directional trades.
 */
export const CHOP_ER_THRESHOLD = 0.25;
export const ER_LOOKBACK = 50;

export function efficiencyRatio(closes: number[], lookback = ER_LOOKBACK): number | null {
  if (closes.length < lookback + 1) return null;
  const window = closes.slice(closes.length - lookback - 1);
  let path = 0;
  for (let i = 1; i < window.length; i++) path += Math.abs(window[i] - window[i - 1]);
  if (path <= 0) return 0;
  return Math.abs(window[window.length - 1] - window[0]) / path;
}

export function classifyStructure(
  candles: Candle[],
  swings: Swing[],
  atr: number | null,
): StructureResult | null {
  const base: StructureResult = {
    label: "RANGE",
    longScore: 0,
    shortScore: 0,
    brokeAbove: false,
    brokeBelow: false,
    retestHeldAbove: false,
    retestHeldBelow: false,
    falseBreakoutDown: false,
    falseBreakoutUp: false,
    lastSwingHigh: null,
    lastSwingLow: null,
  };
  if (candles.length < 10 || atr === null || !Number.isFinite(atr) || atr <= 0) {
    return null;
  }
  const highs = swings.filter((s) => s.type === "high");
  const lows = swings.filter((s) => s.type === "low");
  const lastHigh = highs.length > 0 ? highs[highs.length - 1].price : null;
  const lastLow = lows.length > 0 ? lows[lows.length - 1].price : null;
  base.lastSwingHigh = lastHigh;
  base.lastSwingLow = lastLow;

  let long = 0;
  let short = 0;
  if (highs.length >= 2 && lows.length >= 2) {
    const hh = highs[highs.length - 1].price > highs[highs.length - 2].price;
    const hl = lows[lows.length - 1].price > lows[lows.length - 2].price;
    const lh = highs[highs.length - 1].price < highs[highs.length - 2].price;
    const ll = lows[lows.length - 1].price < lows[lows.length - 2].price;
    if (hh && hl) {
      base.label = "BULLISH";
      long += 0.5;
    } else if (lh && ll) {
      base.label = "BEARISH";
      short += 0.5;
    }
  }

  const close = candles[candles.length - 1].close;
  const buf = atr * 0.1;
  if (lastHigh !== null && close > lastHigh + buf) {
    base.brokeAbove = true;
    long += 0.25;
  }
  if (lastLow !== null && close < lastLow - buf) {
    base.brokeBelow = true;
    short += 0.25;
  }

  // Retest: after the most recent breakout close, lows stayed above level.
  const recent = candles.slice(-6);
  if (base.brokeAbove && lastHigh !== null) {
    const held = recent.every((c) => c.low >= lastHigh - atr * 0.25);
    if (held) {
      base.retestHeldAbove = true;
      long += 0.25;
    }
  }
  if (base.brokeBelow && lastLow !== null) {
    const held = recent.every((c) => c.high <= lastLow + atr * 0.25);
    if (held) {
      base.retestHeldBelow = true;
      short += 0.25;
    }
  }

  // False breakout: broke out, then closed back inside within 5 bars.
  if (lastHigh !== null) {
    const brokeIdx = findLastBreakoutClose(candles, lastHigh, "up");
    if (brokeIdx !== null && closedBackInside(candles, brokeIdx, lastHigh, "up")) {
      base.falseBreakoutUp = true;
      long = Math.min(long, 0.25);
    }
  }
  if (lastLow !== null) {
    const brokeIdx = findLastBreakoutClose(candles, lastLow, "down");
    if (brokeIdx !== null && closedBackInside(candles, brokeIdx, lastLow, "down")) {
      base.falseBreakoutDown = true;
      short = Math.min(short, 0.25);
    }
  }

  base.longScore = Math.min(1, long);
  base.shortScore = Math.min(1, short);
  return base;
}

function findLastBreakoutClose(
  candles: Candle[],
  level: number,
  dir: "up" | "down",
): number | null {
  for (let i = candles.length - 1; i >= Math.max(0, candles.length - 12); i--) {
    const c = candles[i].close;
    if (dir === "up" && c > level) return i;
    if (dir === "down" && c < level) return i;
  }
  return null;
}

function closedBackInside(
  candles: Candle[],
  brokeIdx: number,
  level: number,
  dir: "up" | "down",
): boolean {
  for (let i = brokeIdx + 1; i < Math.min(candles.length, brokeIdx + 6); i++) {
    const c = candles[i].close;
    if (dir === "up" && c < level) return true;
    if (dir === "down" && c > level) return true;
  }
  return false;
}
