/**
 * Market classification for the Markets page (stocks / commodities).
 *
 * Evidence (live Hyperliquid metadata, observed 2026-09-29):
 * - `metaAndAssetCtxs` carries NO asset-class field — only name/decimals/
 *   leverage/delisted. Classification beyond the dex boundary is therefore
 *   naming-based and MUST stay conservative: exact base-name matches only,
 *   never substring guessing ("GAS" could be natural gas or a crypto token).
 * - Main dex ("") lists unprefixed crypto perps (BTC, ETH, ...).
 * - HIP-3 builder dexes (xyz, flx, km, ...) list `dex:COIN` names mixing
 *   tokenized equities (xyz:NVDA, xyz:AAPL), commodities (xyz:GOLD,
 *   xyz:NATGAS, flx:OIL), indices (xyz:SP500), forex (xyz:EUR, km:USBOND),
 *   volatility (xyz:VIX) and mirrored crypto (flx:BTC, hyna:ETH).
 *
 * Rules (applied to live data — nothing here hard-codes WHICH markets exist,
 * only which base names are unambiguous):
 * 1. No `dex:` prefix (main dex)                    -> crypto.
 * 2. Base name also listed on the main dex           -> crypto (mirrored perp).
 * 3. Base name in COMMODITIES (exact match)          -> commodities.
 * 4. Base name in NON_EQUITY (indices/forex/vol/     -> other (never scanned
 *    crypto-baskets/ambiguous)                          as stocks).
 * 5. Anything else HIP-3                            -> stocks (tokenized
 *    equity shelf of builder dexes; unknowns stay visible with real counts
 *    and the Other bucket absorbs the known non-equities).
 */

export type MarketClass = "crypto" | "stocks" | "commodities" | "other";

/** The three user-facing signal categories (tabs, filters, settings). */
export type MarketCategory = "crypto" | "stocks" | "commodities";

export const CATEGORY_LABEL: Record<MarketCategory | "other", string> = {
  crypto: "CRYPTO",
  stocks: "STOCK",
  commodities: "COMMODITY",
  other: "OTHER",
};

/** Part after the first `dex:` — uppercased for exact matching. */
export function baseSymbol(symbol: string): string {
  const i = symbol.indexOf(":");
  return (i >= 0 ? symbol.slice(i + 1) : symbol).toUpperCase();
}

/** Energy, metals and agriculturals observed as HIP-3 perps (exact match). */
const COMMODITIES = new Set([
  // Metals
  "GOLD",
  "SILVER",
  "COPPER",
  "PLATINUM",
  "PALLADIUM",
  "ALUMINIUM",
  "URANIUM",
  // Energy
  "OIL",
  "BRENT",
  "BRENTOIL",
  "WTI",
  "CL",
  "USOIL",
  "NATGAS",
  "TTF",
  // Agriculturals
  "WHEAT",
  "CORN",
]);

/**
 * HIP-3 names that are provably NOT single-company equities: equity/bond
 * indices and ETFs baskets, forex, volatility, crypto baskets, and
 * ambiguous tickers (GAS/URNM/DRAM/GOLDJM-style could be either).
 */
const NON_EQUITY = new Set([
  // Indices / ETFs / baskets
  "SP500",
  "USA500",
  "US500",
  "SMALL2000",
  "USTECH",
  "NIFTY",
  "JP225",
  "KR200",
  "EWJ",
  "EWT",
  "EWY",
  "EWZ",
  "XLE",
  "SMH",
  "SEMI",
  "MAG7",
  "SEMIS",
  "ROBOT",
  "INFOTECH",
  "NUCLEAR",
  "DEFENSE",
  "ENERGY",
  "BIOTECH",
  "XYZ100",
  // Forex / rates
  "EUR",
  "GBP",
  "JPY",
  "KRW",
  "DXY",
  "USBOND",
  // Volatility
  "VIX",
  "VOL",
  // Crypto baskets
  "TOTAL2",
  "OTHERS",
  "BTCD",
  // Ambiguous — could be commodity, equity, or crypto token
  "GAS",
  "URNM",
  "DRAM",
  "GOLDJM",
  "SILVERJM",
]);

export function classifyMarket(symbol: string, mainDexSymbols: Set<string>): MarketClass {
  const upper = symbol.toUpperCase();
  if (!upper.includes(":")) return "crypto";
  const base = baseSymbol(symbol);
  if (mainDexSymbols.has(base)) return "crypto";
  if (COMMODITIES.has(base)) return "commodities";
  if (NON_EQUITY.has(base)) return "other";
  return "stocks";
}

/** Split a market list into the four classes (pure; counts stay honest). */
export function classifyMarkets(
  symbols: string[],
  mainDexSymbols: Set<string>,
): Record<MarketClass, string[]> {
  const out: Record<MarketClass, string[]> = { crypto: [], stocks: [], commodities: [], other: [] };
  for (const s of symbols) out[classifyMarket(s, mainDexSymbols)].push(s);
  return out;
}
