import type { Market } from "../market/hyperliquid/types";

/**
 * Deterministic market-regime summary for the dashboard. Uses ONLY supplied
 * market data: BTC/ETH trend snapshots plus breadth (share of markets up
 * 24h) and chop (median |24h%|). Labeled deterministic — an LLM backend may
 * rephrase it later, but never with different data.
 */

export interface RegimeSummary {
  regime: "BULLISH" | "NEUTRAL" | "BEARISH";
  /** Independent volatility flag — wild markets overlay any regime. */
  volatility: "NORMAL" | "HIGH VOLATILITY";
  explanation: string;
  btcChangePct: number | null;
  ethChangePct: number | null;
  breadthUpPct: number | null;
  medianAbsChangePct: number | null;
  marketsCounted: number;
}

export function summarizeRegime(markets: Market[]): RegimeSummary {
  const empty: RegimeSummary = {
    regime: "NEUTRAL",
    volatility: "NORMAL",
    explanation: "Data unavailable — not enough market coverage to assess regime.",
    btcChangePct: null,
    ethChangePct: null,
    breadthUpPct: null,
    medianAbsChangePct: null,
    marketsCounted: 0,
  };
  const withChange = markets.filter((m) => m.dayChangePct !== null && Number.isFinite(m.dayChangePct));
  if (withChange.length < 10) return empty;
  const btc = markets.find((m) => m.symbol === "BTC")?.dayChangePct ?? null;
  const eth = markets.find((m) => m.symbol === "ETH")?.dayChangePct ?? null;
  const ups = withChange.filter((m) => (m.dayChangePct as number) > 1).length;
  const downs = withChange.filter((m) => (m.dayChangePct as number) < -1).length;
  const breadth = 50 + ((ups - downs) / withChange.length) * 50;
  const absSorted = withChange
    .map((m) => Math.abs(m.dayChangePct as number))
    .sort((a, b) => a - b);
  const median = absSorted[Math.floor(absSorted.length / 2)];

  let score = 0;
  if (btc !== null) score += Math.max(-2, Math.min(2, btc / 2));
  if (eth !== null) score += Math.max(-2, Math.min(2, eth / 2));
  score += (breadth - 50) / 25; // ±2 at full breadth extremes
  const regime = score >= 1.5 ? "BULLISH" : score <= -1.5 ? "BEARISH" : "NEUTRAL";
  const volatility = median > 4 ? "HIGH VOLATILITY" : "NORMAL";

  const parts = [
    `BTC ${fmtSigned(btc)} / ETH ${fmtSigned(eth)} on 24h`,
    `${breadth.toFixed(0)}% of ${withChange.length} markets up`,
    median < 1 ? "chop is tight" : median > 4 ? "moves are violent" : "typical dispersion",
  ];
  return {
    regime,
    volatility,
    explanation: `${regime[0]}${regime.slice(1).toLowerCase()} regime${volatility === "HIGH VOLATILITY" ? " under high volatility" : ""}: ${parts.join("; ")}. Computed from supplied market data only.`,
    btcChangePct: btc,
    ethChangePct: eth,
    breadthUpPct: Math.round(breadth * 10) / 10,
    medianAbsChangePct: Math.round(median * 100) / 100,
    marketsCounted: withChange.length,
  };
}

function fmtSigned(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return "data unavailable";
  return `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
}
