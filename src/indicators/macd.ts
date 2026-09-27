import { emaSeries } from "./ema";

/**
 * MACD: line = fastEMA − slowEMA, signal = EMA(signalPeriod) of the line,
 * histogram = line − signal. Defaults 12/26/9. The signal seed is the SMA
 * of the first `signalPeriod` defined line values. Unready positions are
 * null (INSUFFICIENT DATA), including the whole series when history is short.
 */

export interface MacdPoint {
  line: number | null;
  signal: number | null;
  histogram: number | null;
}

export function macdSeries(
  closes: number[],
  fastPeriod = 12,
  slowPeriod = 26,
  signalPeriod = 9,
): MacdPoint[] {
  const out: MacdPoint[] = closes.map(() => ({ line: null, signal: null, histogram: null }));
  if (closes.length === 0) return out;
  const fast = emaSeries(closes, fastPeriod);
  const slow = emaSeries(closes, slowPeriod);
  const lineIdx: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    if (fast[i] !== null && slow[i] !== null) {
      const line = (fast[i] as number) - (slow[i] as number);
      out[i].line = line;
      lineIdx.push(i);
    }
  }
  if (lineIdx.length < signalPeriod) return out;
  const k = 2 / (signalPeriod + 1);
  let prev = 0;
  for (let j = 0; j < signalPeriod; j++) prev += out[lineIdx[j]].line as number;
  prev /= signalPeriod;
  const seedAt = lineIdx[signalPeriod - 1];
  out[seedAt].signal = prev;
  out[seedAt].histogram = (out[seedAt].line as number) - prev;
  for (let j = signalPeriod; j < lineIdx.length; j++) {
    const i = lineIdx[j];
    prev = (out[i].line as number) * k + prev * (1 - k);
    out[i].signal = prev;
    out[i].histogram = (out[i].line as number) - prev;
  }
  return out;
}

/** Last MACD point (fields may individually be null when unready). */
export function lastMacd(
  closes: number[],
  fastPeriod = 12,
  slowPeriod = 26,
  signalPeriod = 9,
): MacdPoint {
  if (closes.length === 0) return { line: null, signal: null, histogram: null };
  const s = macdSeries(closes, fastPeriod, slowPeriod, signalPeriod);
  return s[s.length - 1];
}
