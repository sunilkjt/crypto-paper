import { beforeEach, describe, expect, it } from "vitest";
import { LocalExplainerProvider } from "../providers/localExplainer";
import { getAiAnalysis } from "../analyst";
import { clearAiCache } from "../cache";
import { resetRateLimitForTests } from "../ratelimit";
import type { AiAnalysisInput, AIProvider } from "../types";

function inputFor(over: Partial<AiAnalysisInput> = {}): AiAnalysisInput {
  const tf = {
    trend: "BULLISH",
    ema20: 10,
    ema50: 9,
    ema200: 8,
    rsi: 60,
    macdLine: 0.1,
    macdSignal: 0.05,
    macdHistogram: 0.05,
    atr: 0.5,
    structure: "BULLISH",
  };
  return {
    symbol: "BTC",
    currentPrice: 108240,
    change24hPct: 1.8,
    volume24hNotional: 1000000,
    fundingRate: 0.0001,
    openInterestNotional: 500000,
    timeframes: { "4h": tf, "1h": tf, "15m": tf, "5m": tf },
    nearestSupport: 107500,
    strongSupport: 106800,
    nearestResistance: 110800,
    strongResistance: 112000,
    signalDirection: "LONG",
    signalStrength: 86,
    entryLow: 108200,
    entryHigh: 108240,
    invalidation: 106800,
    tp1: 110500,
    tp2: 112000,
    tp3: 113500,
    riskReward: 1.64,
    signalReasons: ["Momentum recovering"],
    signalWarnings: [],
    bounceScore: null,
    bounceDirection: null,
    marketDataTimestamp: 100,
    analysisTimestamp: Date.now(),
    news: [],
    ...over,
  };
}

function countingProvider(counter: { calls: number }): AIProvider {
  const inner = new LocalExplainerProvider();
  return {
    name: "counting",
    kind: "local-explainer",
    analyze: async (input) => {
      counter.calls += 1;
      return inner.analyze(input);
    },
  };
}

beforeEach(() => {
  clearAiCache();
  resetRateLimitForTests();
});

describe("signal-stable AI cache (tick storm regression)", () => {
  it("price ticks rebuild the input but reuse the cached explanation (1 backend call)", async () => {
    const counter = { calls: 0 };
    const provider = countingProvider(counter);
    // Three rebuilds of the SAME signal, each with a fresh analysisTimestamp
    // exactly as buildAiInput mints on every market tick.
    for (let i = 0; i < 3; i++) {
      const res = await getAiAnalysis({ input: inputFor(), timeframe: "15m", provider });
      expect(res.status).toBe("ok");
    }
    expect(counter.calls).toBe(1);
    const again = await getAiAnalysis({ input: inputFor(), timeframe: "15m", provider });
    expect(again.cached).toBe(true);
    expect(counter.calls).toBe(1);
  });

  it("material changes (strength, direction, new candle) refetch", async () => {
    const counter = { calls: 0 };
    const provider = countingProvider(counter);
    await getAiAnalysis({ input: inputFor(), timeframe: "15m", provider });
    expect(counter.calls).toBe(1);

    resetRateLimitForTests();
    await getAiAnalysis({ input: inputFor({ signalStrength: 88 }), timeframe: "15m", provider });
    expect(counter.calls).toBe(2);

    resetRateLimitForTests();
    await getAiAnalysis({ input: inputFor({ signalDirection: "SHORT" }), timeframe: "15m", provider });
    expect(counter.calls).toBe(3);

    resetRateLimitForTests();
    await getAiAnalysis({ input: inputFor({ marketDataTimestamp: 200 }), timeframe: "15m", provider });
    expect(counter.calls).toBe(4);
  });
});
