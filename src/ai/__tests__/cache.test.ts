import { describe, expect, it } from "vitest";
import { aiCacheKey, clearAiCache, getCachedAi, setCachedAi } from "../cache";
import { dedupedRequest, resetRateLimitForTests, throttleDelayMs } from "../ratelimit";
import { summarizeRegime } from "../regime";
import type { Market } from "../../market/hyperliquid/types";

function market(symbol: string, chg: number | null): Market {
  return {
    symbol,
    markPrice: 100,
    oraclePrice: 100,
    dayVolumeNotional: 1000,
    dayChangePct: chg,
    fundingRate: 0,
    openInterestCoins: 10,
    openInterestNotional: 1000,
    prevDayPrice: 99,
    midPrice: 100,
  };
}

describe("ai cache", () => {
  it("keys on symbol+timeframe+signal+data timestamps and expires", () => {
    clearAiCache();
    const key = aiCacheKey("op", "15m", { timestamp: 2, dataTimestamp: 1 });
    expect(key).toBe("ai:OP:15m:2:1");
    const analysis = {
      summary: "s",
      marketStructure: "ms",
      setup: "st",
      confirmations: [],
      conflicts: [],
      risks: [],
      invalidation: "inv",
      catalysts: [],
      conclusion: "c",
      directionEcho: "WAIT" as const,
      provider: "p",
      analysisTimestamp: 3,
      marketDataTimestamp: 1,
    };
    const input = { marketDataTimestamp: 1 } as never;
    setCachedAi(key, analysis);
    expect(getCachedAi(key, input)?.summary).toBe("s");
    // New data timestamp → same key serves nothing (honest refresh).
    expect(getCachedAi(key, { marketDataTimestamp: 2 } as never)).toBeNull();
  });
});

describe("rate limiting", () => {
  it("throttles repeat keys and dedupes inflight", async () => {
    resetRateLimitForTests();
    expect(throttleDelayMs("k")).toBe(0);
    const { markCalled } = await import("../ratelimit");
    markCalled("k");
    expect(throttleDelayMs("k")).toBeGreaterThan(9000);
    let calls = 0;
    const task = async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 20));
      return "v";
    };
    const [a, b] = await Promise.all([dedupedRequest("d", task), dedupedRequest("d", task)]);
    expect(a).toBe("v");
    expect(b).toBe("v");
    expect(calls).toBe(1);
  });
});

describe("regime summary", () => {
  it("reads bullish/bearish breadth from supplied markets only", () => {
    const bull = Array.from({ length: 20 }, (_, i) => market(i === 0 ? "BTC" : i === 1 ? "ETH" : `C${i}`, 3));
    expect(summarizeRegime(bull).regime).toBe("BULLISH");
    const bear = bull.map((m) => ({ ...m, dayChangePct: -3 }));
    expect(summarizeRegime(bear).regime).toBe("BEARISH");
    const flat = bull.map((m) => ({ ...m, dayChangePct: 0.1 }));
    expect(summarizeRegime(flat).regime).toBe("NEUTRAL");
  });

  it("flags high volatility independently of direction", () => {
    const wild = Array.from({ length: 20 }, (_, i) =>
      market(i === 0 ? "BTC" : `C${i}`, i % 2 === 0 ? 8 : -8),
    );
    const r = summarizeRegime(wild);
    expect(r.volatility).toBe("HIGH VOLATILITY");
    expect(r.explanation).toMatch(/high volatility/);
  });

  it("admits insufficient coverage honestly", () => {
    expect(summarizeRegime([]).explanation).toMatch(/Data unavailable/);
    expect(summarizeRegime([market("BTC", 5)]).marketsCounted).toBe(0);
  });
});
