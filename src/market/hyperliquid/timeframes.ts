import type { Timeframe } from "./types";

export const SUPPORTED_TIMEFRAMES: readonly Timeframe[] = [
  "1m",
  "5m",
  "15m",
  "1h",
  "4h",
] as const;

const TIMEFRAME_MS: Record<Timeframe, number> = {
  "1m": 60_000,
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
  "4h": 4 * 60 * 60_000,
};

/** UI timeframe -> Hyperliquid interval string (identity for supported set). */
export function toHyperliquidInterval(tf: Timeframe): string {
  return tf;
}

export function timeframeToMs(tf: Timeframe): number {
  return TIMEFRAME_MS[tf];
}

export function isSupportedTimeframe(value: string): value is Timeframe {
  return (SUPPORTED_TIMEFRAMES as readonly string[]).includes(value);
}

/**
 * Window for a fresh history load: last `limit` candles ending now.
 * Hyperliquid keeps max 5000 candles; we request 300 for a responsive chart.
 * NOTE: the trailing candle may still be forming — signal generation must
 * pass fetched arrays through getClosedCandles first (charts may display
 * the forming bar; the engine must never score it).
 */
export function getCandleWindow(
  tf: Timeframe,
  endTime = Date.now(),
  limit = 300,
): { startTime: number; endTime: number } {
  const span = TIMEFRAME_MS[tf] * limit;
  return { startTime: endTime - span, endTime };
}

/**
 * Closed-candle enforcement (single shared rule). Hyperliquid candle `t`
 * is the interval OPEN time (UTC epoch ms); the bar is closed once
 * `t + interval <= now`. Only the trailing array edge can be forming —
 * historical bars are always closed — so trimming is a suffix operation.
 * Clock skew note: callers pass fetch-time `now`; a behind-clock trims
 * conservatively (safe), tests inject exact boundaries.
 */
export function isCandleClosed(openTime: number, tf: Timeframe, now = Date.now()): boolean {
  return Number.isFinite(openTime) && openTime + TIMEFRAME_MS[tf] <= now;
}

/** Latest interval boundary at or before `now` (the newest possible close). */
export function closedBoundary(tf: Timeframe, now = Date.now()): number {
  return Math.floor(now / TIMEFRAME_MS[tf]) * TIMEFRAME_MS[tf];
}

/** Drop the trailing still-forming candle(s); returns a new array. */
export function getClosedCandles<T extends { timestamp: number }>(
  candles: T[],
  tf: Timeframe,
  now = Date.now(),
): T[] {
  let end = candles.length;
  while (end > 0 && !isCandleClosed(candles[end - 1].timestamp, tf, now)) end -= 1;
  return end === candles.length ? candles.slice() : candles.slice(0, end);
}
