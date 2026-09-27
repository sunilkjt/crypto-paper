/**
 * Phase 2 — Hyperliquid public market-data types.
 * UI must only consume the normalized types (Market, Candle, ...).
 * Raw Hyperliquid shapes stay inside src/market/hyperliquid/.
 */

export type Timeframe = "1m" | "5m" | "15m" | "1h" | "4h";

export interface Market {
  symbol: string;
  markPrice: number | null;
  oraclePrice: number | null;
  dayVolumeNotional: number | null;
  dayChangePct: number | null;
  fundingRate: number | null;
  openInterestCoins: number | null;
  openInterestNotional: number | null;
  prevDayPrice: number | null;
  midPrice: number | null;
}

export interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Ticker {
  symbol: string;
  mid: number | null;
  mark: number | null;
  updatedAt: number;
}

export interface Funding {
  symbol: string;
  fundingRate: number | null;
}

export interface OpenInterest {
  symbol: string;
  openInterestCoins: number | null;
  openInterestNotional: number | null;
}

export interface MarketData {
  markets: Market[];
  updatedAt: number;
  source: "hyperliquid-rest" | "hyperliquid-ws" | "cache";
}

export type MarketStatus = "loading" | "live" | "stale" | "error";

export class HyperliquidError extends Error {
  readonly kind:
    | "network"
    | "timeout"
    | "rate-limited"
    | "invalid-response"
    | "missing-market"
    | "missing-candles"
    | "api";
  readonly retryable: boolean;

  constructor(
    kind: HyperliquidError["kind"],
    message: string,
    retryable = true,
  ) {
    super(message);
    this.name = "HyperliquidError";
    this.kind = kind;
    this.retryable = retryable;
  }
}

/* ---------- Raw Hyperliquid API shapes (never exported to UI) ---------- */

export interface RawUniverseEntry {
  name: string;
  szDecimals: number;
  maxLeverage?: number;
  onlyIsolated?: boolean;
  isDelisted?: boolean;
}

export interface RawAssetCtx {
  dayNtlVlm?: string | null;
  funding?: string | null;
  markPx?: string | null;
  midPx?: string | null;
  openInterest?: string | null;
  oraclePx?: string | null;
  premium?: string | null;
  prevDayPx?: string | null;
}

export type RawMetaAndAssetCtxs = [
  { universe: RawUniverseEntry[] },
  RawAssetCtx[],
];

export interface RawCandle {
  t: number;
  T: number;
  s: string;
  i: string;
  o: string;
  h: string;
  l: string;
  c: string;
  v: string;
  n: number;
}

export interface RawWsCandle {
  t: number;
  T: number;
  s: string;
  i: string;
  o: number;
  c: number;
  h: number;
  l: number;
  v: number;
  n: number;
}
