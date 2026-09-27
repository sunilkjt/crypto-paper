/**
 * Exponential Moving Average. SMA-seeded (standard): the first value is the
 * simple average of the first `period` closes, then Wilder-style smoothing
 * with k = 2 / (period + 1). Positions before the seed stay null —
 * callers treat null as INSUFFICIENT DATA, never as zero.
 */

export function emaSeries(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (!Number.isInteger(period) || period < 2) return out;
  if (values.length < period) return out;
  if (values.some((v) => !Number.isFinite(v))) return out;
  const k = 2 / (period + 1);
  let prev = 0;
  for (let i = 0; i < period; i++) prev += values[i];
  prev /= period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Last EMA value, or null when history is insufficient. */
export function lastEma(values: number[], period: number): number | null {
  if (values.length === 0) return null;
  const s = emaSeries(values, period);
  return s[s.length - 1];
}
