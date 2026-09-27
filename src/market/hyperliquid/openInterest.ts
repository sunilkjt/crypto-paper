import type { OpenInterest } from "./types";

/** Extract open interest for one market (pure helper). */
export function toOpenInterest(
  symbol: string,
  openInterestCoins: number | null,
  openInterestNotional: number | null,
): OpenInterest {
  return {
    symbol: symbol.toUpperCase(),
    openInterestCoins,
    openInterestNotional,
  };
}

/** Compact USD formatting for OI notional. Null-safe, never invents values. */
export function formatOpenInterestNotional(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  if (value >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(2)}B`;
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  return `$${value.toFixed(0)}`;
}
