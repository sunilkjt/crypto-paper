/**
 * Per-coin relevance keyword maps. A story is relevant when its headline or
 * summary mentions the coin, project, or ecosystem terms. Broad-market terms
 * (bitcoin, ethereum, market-wide) count only weakly — an OP catalyst must
 * be about Optimism, not merely mention BTC.
 */

const COIN_KEYWORDS: Record<string, string[]> = {
  OP: ["optimism", " op ", "op mainnet", "superchain", "optimism ecosystem", "op stack"],
  BTC: ["bitcoin", " btc "],
  ETH: ["ethereum", " eth ", "ether ", "vitalik", "ethereum foundation"],
  SOL: ["solana", " sol "],
  ARB: ["arbitrum", " arb "],
  AVAX: ["avalanche", "avax"],
  LINK: ["chainlink", "link "],
  DOGE: ["dogecoin", "doge"],
  HYPE: ["hyperliquid", "hype", "hyperliquid foundation"],
};

const MARKET_WIDE = ["bitcoin", "ethereum", "federal reserve", "sec", "etf", "macro", "market-wide"];

export interface RelevanceResult {
  relevant: boolean;
  /** 0..1 — direct coin match scores high, market-wide context low. */
  score: number;
  matched: string[];
}

export function coinKeywords(symbol: string): string[] {
  return COIN_KEYWORDS[symbol.toUpperCase()] ?? [symbol.toLowerCase()];
}

export function scoreRelevance(
  symbol: string,
  headline: string,
  summary: string,
): RelevanceResult {
  const text = ` ${headline} ${summary} `.toLowerCase();
  const matched: string[] = [];
  for (const kw of coinKeywords(symbol)) {
    if (text.includes(kw)) matched.push(kw.trim());
  }
  if (matched.length > 0) {
    return { relevant: true, score: Math.min(1, 0.5 + matched.length * 0.25), matched };
  }
  const marketHits = MARKET_WIDE.filter((kw) => text.includes(kw));
  if (marketHits.length > 0) {
    return { relevant: true, score: 0.25, matched: marketHits };
  }
  return { relevant: false, score: 0, matched: [] };
}
