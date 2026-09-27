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
 */
export function getCandleWindow(
  tf: Timeframe,
  endTime = Date.now(),
  limit = 300,
): { startTime: number; endTime: number } {
  const span = TIMEFRAME_MS[tf] * limit;
  return { startTime: endTime - span, endTime };
}
