/**
 * RSI (Wilder). First average gain/loss over `period` changes, then
 * Wilder smoothing: avg = (prevAvg * (period - 1) + current) / period.
 * Flat market (no gain, no loss) yields exactly 50. All-up yields 100,
 * all-down yields 0. Leading positions stay null (INSUFFICIENT DATA).
 */

export function rsiSeries(closes: number[], period = 14): (number | null)[] {
  const out: (number | null)[] = new Array(closes.length).fill(null);
  if (!Number.isInteger(period) || period < 2) return out;
  if (closes.length < period + 1) return out;
  if (closes.some((v) => !Number.isFinite(v))) return out;

  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const chg = closes[i] - closes[i - 1];
    if (chg > 0) avgGain += chg;
    else avgLoss -= chg;
  }
  avgGain /= period;
  avgLoss /= period;
  out[period] = rsiFromAverages(avgGain, avgLoss);

  for (let i = period + 1; i < closes.length; i++) {
    const chg = closes[i] - closes[i - 1];
    const gain = chg > 0 ? chg : 0;
    const loss = chg < 0 ? -chg : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = rsiFromAverages(avgGain, avgLoss);
  }
  return out;
}

function rsiFromAverages(avgGain: number, avgLoss: number): number {
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/** Last RSI value, or null when history is insufficient. */
export function lastRsi(closes: number[], period = 14): number | null {
  if (closes.length === 0) return null;
  const s = rsiSeries(closes, period);
  return s[s.length - 1];
}
