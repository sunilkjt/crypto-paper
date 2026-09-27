/**
 * Trend classification from EMA stack + price position.
 * Five bullish conditions (price>EMA20, price>EMA50, price>EMA200,
 * EMA20>EMA50, EMA50>EMA200) and their bearish mirrors are counted —
 * no single indicator decides alone. `epsilon` (e.g. 5% of ATR) keeps
 * dust-level touches inside converged stacks from flipping labels.
 * Null inputs → null (INSUFFICIENT DATA).
 */

export type TrendLabel =
  | "STRONG BULLISH"
  | "BULLISH"
  | "NEUTRAL"
  | "BEARISH"
  | "STRONG BEARISH";

export interface TrendResult {
  label: TrendLabel;
  /** 0..5 bullish conditions true. */
  bullPoints: number;
  /** 0..5 bearish conditions true. */
  bearPoints: number;
}

export function classifyTrend(
  price: number | null,
  ema20: number | null,
  ema50: number | null,
  ema200: number | null,
  epsilon = 0,
): TrendResult | null {
  if (
    price === null ||
    ema20 === null ||
    ema50 === null ||
    ema200 === null ||
    ![price, ema20, ema50, ema200].every(Number.isFinite)
  ) {
    return null;
  }
  const gt = (a: number, b: number) => a > b + epsilon;
  const lt = (a: number, b: number) => a < b - epsilon;
  const bull =
    (gt(price, ema20) ? 1 : 0) +
    (gt(price, ema50) ? 1 : 0) +
    (gt(price, ema200) ? 1 : 0) +
    (gt(ema20, ema50) ? 1 : 0) +
    (gt(ema50, ema200) ? 1 : 0);
  const bear =
    (lt(price, ema20) ? 1 : 0) +
    (lt(price, ema50) ? 1 : 0) +
    (lt(price, ema200) ? 1 : 0) +
    (lt(ema20, ema50) ? 1 : 0) +
    (lt(ema50, ema200) ? 1 : 0);
  let label: TrendLabel;
  if (bull === 5) label = "STRONG BULLISH";
  else if (bull === 4) label = "BULLISH";
  else if (bear === 5) label = "STRONG BEARISH";
  else if (bear === 4) label = "BEARISH";
  else label = "NEUTRAL";
  return { label, bullPoints: bull, bearPoints: bear };
}
