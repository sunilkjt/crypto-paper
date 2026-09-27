import type { Candle } from "../market/hyperliquid/types";
import { lastEma } from "../indicators/ema";
import { lastRsi } from "../indicators/rsi";
import { lastMacd } from "../indicators/macd";
import { lastAtr } from "../indicators/atr";
import { detectSwings } from "./swings";
import { classifyStructure } from "./structure";
import { classifyTrend } from "./trend";
import type { AiTimeframeFacts } from "../ai/types";

/**
 * Compact per-timeframe fact sheet for AI input. Same deterministic math
 * as the signal engine; nulls flow through as "Data unavailable."
 */
export function describeTimeframe(candles: Candle[] | undefined): AiTimeframeFacts {
  const fallback: AiTimeframeFacts = {
    trend: "INSUFFICIENT",
    ema20: null,
    ema50: null,
    ema200: null,
    rsi: null,
    macdLine: null,
    macdSignal: null,
    macdHistogram: null,
    atr: null,
    structure: "INSUFFICIENT",
  };
  if (!candles || candles.length < 210) return fallback;
  const closes = candles.map((c) => c.close);
  const price = closes[closes.length - 1];
  const e20 = lastEma(closes, 20);
  const e50 = lastEma(closes, 50);
  const e200 = lastEma(closes, 200);
  const atr = lastAtr(candles, 14);
  const trend = classifyTrend(price, e20, e50, e200, (atr ?? 0) * 0.05);
  const macd = lastMacd(closes);
  const structure = classifyStructure(candles, detectSwings(candles, 3, 120), atr);
  return {
    trend: trend?.label ?? "INSUFFICIENT",
    ema20: e20,
    ema50: e50,
    ema200: e200,
    rsi: lastRsi(closes, 14),
    macdLine: macd.line,
    macdSignal: macd.signal,
    macdHistogram: macd.histogram,
    atr,
    structure: structure?.label ?? "INSUFFICIENT",
  };
}
