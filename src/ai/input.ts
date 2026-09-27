import type { Candle, Market, Timeframe } from "../market/hyperliquid/types";
import { describeTimeframe } from "../analysis/describe";
import { detectSwings } from "../analysis/swings";
import { buildLevels } from "../analysis/levels";
import { lastAtr } from "../indicators/atr";
import type { Signal } from "../analysis/signal";
import type { AiAnalysisInput, AiNewsItem } from "./types";
import { isValidAiInput } from "./validate";

/**
 * Build the structured AI input from engine output + market snapshot.
 * Every number originates in the deterministic engine or the live feed —
 * the builder copies, never computes or invents.
 */
export function buildAiInput(args: {
  symbol: string;
  market: Market | undefined;
  candlesByTf: Partial<Record<Timeframe, Candle[]>>;
  signal: Signal;
  news: AiNewsItem[];
}): AiAnalysisInput {
  const { symbol, market, candlesByTf, signal, news } = args;
  const setup = candlesByTf["15m"] ?? [];
  const price = setup.length > 0 ? setup[setup.length - 1].close : (market?.markPrice ?? null);
  const atr = setup.length > 0 ? lastAtr(setup, 14) : null;
  const levels =
    atr !== null
      ? buildLevels(detectSwings(setup, 3, 120), price ?? 0, atr)
      : { nearestSupport: null, strongSupport: null, nearestResistance: null, strongResistance: null };

  const input: AiAnalysisInput = {
    symbol: symbol.toUpperCase(),
    currentPrice: price,
    change24hPct: market?.dayChangePct ?? null,
    volume24hNotional: market?.dayVolumeNotional ?? null,
    fundingRate: market?.fundingRate ?? null,
    openInterestNotional: market?.openInterestNotional ?? null,
    timeframes: {
      "4h": describeTimeframe(candlesByTf["4h"]),
      "1h": describeTimeframe(candlesByTf["1h"]),
      "15m": describeTimeframe(candlesByTf["15m"]),
      "5m": describeTimeframe(candlesByTf["5m"]),
    },
    nearestSupport: levels.nearestSupport?.price ?? null,
    strongSupport: levels.strongSupport?.price ?? null,
    nearestResistance: levels.nearestResistance?.price ?? null,
    strongResistance: levels.strongResistance?.price ?? null,
    signalDirection: signal.direction,
    signalStrength: signal.signalStrength,
    entryLow: signal.entryLow,
    entryHigh: signal.entryHigh,
    invalidation: signal.invalidation,
    tp1: signal.tp1,
    tp2: signal.tp2,
    tp3: signal.tp3,
    riskReward: signal.riskReward,
    signalReasons: signal.reasons,
    signalWarnings: signal.warnings,
    bounceScore: signal.bounce?.bounceScore ?? null,
    bounceDirection: signal.bounce?.direction ?? null,
    marketDataTimestamp: signal.dataTimestamp,
    analysisTimestamp: Date.now(),
    news,
  };
  if (!isValidAiInput(input)) {
    throw new Error("AI input failed shape validation.");
  }
  return input;
}
