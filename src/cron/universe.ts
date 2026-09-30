import { classifyMarket, type MarketCategory } from "../market/classify";
import type { Market } from "../market/hyperliquid/types";

/**
 * Category universes for headless scans. Pure derivation over the live
 * market list — the same classifier the UI uses, so cron and browser
 * scans always agree on what belongs where.
 */

/** Main-dex (unprefixed) symbol set for the crypto-mirror rule. */
export function mainDexSymbols(markets: Market[]): Set<string> {
  return new Set(
    markets.filter((m) => !m.symbol.includes(":")).map((m) => m.symbol.toUpperCase()),
  );
}

/** Markets of exactly one category (never mixed, never everything). */
export function buildUniverse(markets: Market[], category: MarketCategory): Market[] {
  const main = mainDexSymbols(markets);
  return markets.filter((m) => classifyMarket(m.symbol, main) === category);
}
