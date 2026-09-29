import { describe, expect, it } from "vitest";
import { aiSignalKey } from "../cache";
import { AI_AUTO_MIN_STRENGTH, __setAiModeStorageForTests, getAiMode, resetAiModeListenersForTests, setAiMode } from "../settings";
import { readAiStats, resetAiStatsForTests } from "../stats";
import { aiQueueDepth, resetRateLimitForTests } from "../ratelimit";
import type { AiAnalysisInput } from "../types";

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
    signalReasons: ["r"],
    signalWarnings: [],
    bounceScore: null,
    bounceDirection: null,
    marketDataTimestamp: 100,
    analysisTimestamp: Date.now(),
    news: [],
    ...over,
  };
}

function memoryStorage(): Storage {
  const store: Record<string, string> = {};
  return {
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => {
      store[k] = v;
    },
    removeItem: (k: string) => {
      delete store[k];
    },
    clear: () => {
      for (const k of Object.keys(store)) delete store[k];
    },
    key: (i: number) => Object.keys(store)[i] ?? null,
    get length() {
      return Object.keys(store).length;
    },
  } as Storage;
}

describe("AI explanation mode setting", () => {
  it("defaults to manual and round-trips off/auto", () => {
    resetAiModeListenersForTests();
    __setAiModeStorageForTests(memoryStorage());
    expect(getAiMode()).toBe("manual");
    setAiMode("off");
    expect(getAiMode()).toBe("off");
    setAiMode("auto");
    expect(getAiMode()).toBe("auto");
    setAiMode("manual");
    expect(getAiMode()).toBe("manual");
    expect(AI_AUTO_MIN_STRENGTH).toBe(75);
    __setAiModeStorageForTests(null);
  });
});

describe("signal fingerprint key", () => {
  it("ignores ticks: new price + fresh timestamp share the key", () => {
    const a = aiSignalKey(inputFor(), "15m");
    const b = aiSignalKey(inputFor({ currentPrice: 108245, analysisTimestamp: Date.now() + 5000 }), "15m");
    expect(a).toBe(b);
  });

  it("plan changes mint a new key (entry, stop, TPs, R:R)", () => {
    const base = aiSignalKey(inputFor(), "15m");
    expect(aiSignalKey(inputFor({ entryLow: 108100 }), "15m")).not.toBe(base);
    expect(aiSignalKey(inputFor({ invalidation: 106700 }), "15m")).not.toBe(base);
    expect(aiSignalKey(inputFor({ tp1: 110600 }), "15m")).not.toBe(base);
    expect(aiSignalKey(inputFor({ riskReward: 2.1 }), "15m")).not.toBe(base);
  });

  it("direction, score, candle and timeframe changes mint new keys", () => {
    const base = aiSignalKey(inputFor(), "15m");
    expect(aiSignalKey(inputFor({ signalDirection: "SHORT" }), "15m")).not.toBe(base);
    expect(aiSignalKey(inputFor({ signalStrength: 82 }), "15m")).not.toBe(base);
    expect(aiSignalKey(inputFor({ marketDataTimestamp: 200 }), "15m")).not.toBe(base);
    expect(aiSignalKey(inputFor(), "1h")).not.toBe(base);
  });
});

describe("AI usage stats + queue depth", () => {
  it("starts at zero and exposes the concurrency queue", () => {
    resetAiStatsForTests();
    resetRateLimitForTests();
    expect(readAiStats()).toEqual({ calls: 0, hits: 0, misses: 0 });
    expect(aiQueueDepth()).toBe(0);
  });
});
