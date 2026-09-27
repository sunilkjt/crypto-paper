import type { Candle } from "../market/hyperliquid/types";

/**
 * ATR (Wilder). True Range = max(high−low, |high−prevClose|, |low−prevClose|),
 * first value seeded with the SMA of the first `period` TRs, then Wilder
 * smoothing. Leading positions stay null (INSUFFICIENT DATA).
 */

export function trueRanges(candles: Candle[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (i === 0) {
      out.push(c.high - c.low);
    } else {
      const prev = candles[i - 1].close;
      out.push(
        Math.max(c.high - c.low, Math.abs(c.high - prev), Math.abs(c.low - prev)),
      );
    }
  }
  return out;
}

export function atrSeries(candles: Candle[], period = 14): (number | null)[] {
  const out: (number | null)[] = new Array(candles.length).fill(null);
  if (!Number.isInteger(period) || period < 2) return out;
  if (candles.length < period) return out;
  const tr = trueRanges(candles);
  if (tr.some((v) => !Number.isFinite(v))) return out;
  let prev = 0;
  for (let i = 0; i < period; i++) prev += tr[i];
  prev /= period;
  out[period - 1] = prev;
  for (let i = period; i < tr.length; i++) {
    prev = (prev * (period - 1) + tr[i]) / period;
    out[i] = prev;
  }
  return out;
}

/** Last ATR value, or null when history is insufficient. */
export function lastAtr(candles: Candle[], period = 14): number | null {
  if (candles.length === 0) return null;
  const s = atrSeries(candles, period);
  return s[s.length - 1];
}
