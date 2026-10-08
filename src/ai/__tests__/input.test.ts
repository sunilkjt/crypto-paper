import { describe, expect, it } from "vitest";
import { buildAiInput } from "../input";
import type { Signal } from "../../analysis/signal";
import type { AiNewsItem } from "../types";

function baseSignal(): Signal {
  return {
    symbol: "OP",
    timestamp: 2000,
    timeframe: "15m",
    direction: "LONG",
    signalStrength: 72,
    classification: "SETUP",
    entryLow: 1.4,
    entryHigh: 1.45,
    entryType: "MARKET",
    entryStatus: "READY",
    invalidation: 1.32,
    tp1: 1.55,
    tp2: 1.65,
    tp3: 1.8,
    riskReward: 2.5,
    trend: "BULLISH",
    momentum: "POSITIVE",
    rsi: 58,
    volume: "HIGH",
    marketStructure: "BULLISH",
    brokeAbove: false,
    brokeBelow: false,
    retestHeld: false,
    riskAtr: 1.5,
    atrPct: 1,
    falseBreakout: false,
    multiTimeframe: null,
    components: { trend: 20, momentum: 14, volume: 12, structure: 14, mtf: 12 },
    bounce: { direction: "LONG", bounceScore: 80, bounceReasons: ["r1"], bounceWarnings: [], components: { support: 25, momentum: 30, volume: 15, structure: 0, mtf: 10 } },
    reasons: ["Bullish confluence"],
    warnings: [],
    dataTimestamp: 1000,
    longScore: 72,
    shortScore: 40,
  };
}

describe("buildAiInput", () => {
  it("copies engine numbers without inventing any", () => {
    const input = buildAiInput({ symbol: "op", market: undefined, candlesByTf: {}, signal: baseSignal(), news: [] });
    expect(input.symbol).toBe("OP");
    expect(input.signalDirection).toBe("LONG");
    expect(input.signalStrength).toBe(72);
    expect(input.entryLow).toBe(1.4);
    expect(input.tp3).toBe(1.8);
    expect(input.riskReward).toBe(2.5);
    expect(input.marketDataTimestamp).toBe(1000);
    expect(input.news).toEqual([]);
    // No candle history → timeframe facts degrade honestly.
    expect(input.timeframes["15m"].trend).toBe("INSUFFICIENT");
    expect(input.timeframes["15m"].rsi).toBeNull();
  });

  it("passes market snapshot fields through", () => {
    const input = buildAiInput({
      symbol: "OP",
      market: {
        symbol: "OP",
        markPrice: 1.44,
        oraclePrice: 1.44,
        dayVolumeNotional: 5_000_000,
        dayChangePct: 2.5,
        fundingRate: 0.0001,
        openInterestCoins: 1000,
        openInterestNotional: 1440,
        prevDayPrice: 1.4,
        midPrice: 1.44,
      },
      candlesByTf: {},
      signal: baseSignal(),
      news: [],
    });
    expect(input.currentPrice).toBe(1.44);
    expect(input.change24hPct).toBe(2.5);
    expect(input.fundingRate).toBe(0.0001);
  });

  it("carries verified news items into the input", () => {
    const news: AiNewsItem[] = [
      { id: "1", headline: "Optimism upgrade", source: "Blog", url: "https://example.com/a", publishedAt: 5, summary: "s", sentiment: "POSITIVE" },
    ];
    const input = buildAiInput({ symbol: "OP", market: undefined, candlesByTf: {}, signal: baseSignal(), news });
    expect(input.news).toHaveLength(1);
    expect(input.news[0].headline).toBe("Optimism upgrade");
  });
});
