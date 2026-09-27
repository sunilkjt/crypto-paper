/**
 * AI analyst types. The deterministic engine owns every number —
 * the AI only ever receives and explains them.
 */

export type AiDirection = "LONG" | "SHORT" | "WAIT";

export interface AiTimeframeFacts {
  trend: string;
  ema20: number | null;
  ema50: number | null;
  ema200: number | null;
  rsi: number | null;
  macdLine: number | null;
  macdSignal: number | null;
  macdHistogram: number | null;
  atr: number | null;
  structure: string;
}

export interface AiNewsItem {
  id: string;
  headline: string;
  source: string;
  url: string;
  publishedAt: number;
  summary: string;
  sentiment: "POSITIVE" | "NEGATIVE" | "NEUTRAL" | "UNCERTAIN";
}

/** Structured input handed to the AI — built from engine output only. */
export interface AiAnalysisInput {
  symbol: string;
  currentPrice: number | null;
  change24hPct: number | null;
  volume24hNotional: number | null;
  fundingRate: number | null;
  openInterestNotional: number | null;
  timeframes: {
    "4h": AiTimeframeFacts;
    "1h": AiTimeframeFacts;
    "15m": AiTimeframeFacts;
    "5m": AiTimeframeFacts;
  };
  nearestSupport: number | null;
  strongSupport: number | null;
  nearestResistance: number | null;
  strongResistance: number | null;
  signalDirection: AiDirection;
  signalStrength: number;
  entryLow: number | null;
  entryHigh: number | null;
  invalidation: number | null;
  tp1: number | null;
  tp2: number | null;
  tp3: number | null;
  riskReward: number | null;
  signalReasons: string[];
  signalWarnings: string[];
  bounceScore: number | null;
  bounceDirection: AiDirection | null;
  marketDataTimestamp: number;
  analysisTimestamp: number;
  news: AiNewsItem[];
}

/** Structured AI output. Text only — no numbers are trusted from the AI. */
export interface AiAnalysis {
  summary: string;
  marketStructure: string;
  setup: string;
  confirmations: string[];
  conflicts: string[];
  risks: string[];
  invalidation: string;
  catalysts: string[];
  conclusion: string;
  /** Must equal the engine direction or the response is rejected. */
  directionEcho: AiDirection;
  provider: string;
  analysisTimestamp: number;
  marketDataTimestamp: number;
}

export interface AIProvider {
  readonly name: string;
  /** Human-readable capability label shown in the UI badge. */
  readonly kind: "local-explainer" | "http-llm";
  analyze(input: AiAnalysisInput, opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<AiAnalysis>;
}

export class AiUnavailableError extends Error {
  constructor(message = "AI analysis temporarily unavailable.") {
    super(message);
    this.name = "AiUnavailableError";
  }
}

export class AiInvalidResponseError extends Error {
  constructor(message = "AI response failed validation.") {
    super(message);
    this.name = "AiInvalidResponseError";
  }
}
