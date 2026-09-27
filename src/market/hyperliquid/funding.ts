import type { Funding } from "./types";

/** Extract the current funding rate for one market (pure helper). */
export function toFunding(symbol: string, fundingRate: number | null): Funding {
  return { symbol: symbol.toUpperCase(), fundingRate };
}

/** Format funding as hourly % string, e.g. 0.0001 -> "0.0100%/h". Null-safe. */
export function formatFundingRate(rate: number | null): string {
  if (rate === null || !Number.isFinite(rate)) return "—";
  return `${(rate * 100).toFixed(4)}%/h`;
}
