import { beforeEach, describe, expect, it } from "vitest";
import { LocalExplainerProvider } from "../providers/localExplainer";
import { getAiAnalysis } from "../analyst";
import { clearAiCache } from "../cache";
import { resetRateLimitForTests } from "../ratelimit";
import { AiUnavailableError, type AiAnalysisInput, type AIProvider } from "../types";

function inputFor(direction: "LONG" | "SHORT" | "WAIT"): AiAnalysisInput {
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
    symbol: "OP",
    currentPrice: 10,
    change24hPct: 2,
    volume24hNotional: 1000,
    fundingRate: 0.0001,
    openInterestNotional: 500,
    timeframes: { "4h": tf, "1h": tf, "15m": tf, "5m": tf },
    nearestSupport: 9,
    strongSupport: 8,
    nearestResistance: 11,
    strongResistance: 12,
    signalDirection: direction,
    signalStrength: direction === "WAIT" ? 20 : 70,
    entryLow: 9.8,
    entryHigh: 10,
    invalidation: 9,
    tp1: 11,
    tp2: 12,
    tp3: 13,
    riskReward: 2,
    signalReasons: ["r"],
    signalWarnings: [],
    bounceScore: null,
    bounceDirection: null,
    marketDataTimestamp: 100,
    analysisTimestamp: 200,
    news: [],
  };
}

beforeEach(() => {
  clearAiCache();
  resetRateLimitForTests();
});

describe("local explainer", () => {
  it("explains WAIT without inventing a trade", async () => {
    const out = await new LocalExplainerProvider().analyze(inputFor("WAIT"));
    expect(out.directionEcho).toBe("WAIT");
    expect(out.conclusion).toMatch(/WAIT/);
    expect(out.summary).toContain("20/100");
  });

  it("echoes LONG/SHORT and quotes supplied numbers", async () => {
    const out = await new LocalExplainerProvider().analyze(inputFor("LONG"));
    expect(out.directionEcho).toBe("LONG");
    expect(out.setup).toContain("9.8");
    expect(out.invalidation).toContain("9");
  });
});

describe("analyst orchestration", () => {
  it("caches by key and serves the second call from cache", async () => {
    const input = inputFor("LONG");
    const first = await getAiAnalysis({ input, timeframe: "15m" });
    expect(first.status).toBe("ok");
    expect(first.cached).toBe(false);
    const second = await getAiAnalysis({ input, timeframe: "15m" });
    expect(second.status).toBe("ok");
    expect(second.cached).toBe(true);
  });

  it("dedupes concurrent identical requests", async () => {
    let calls = 0;
    const provider: AIProvider = {
      name: "counting",
      kind: "local-explainer",
      analyze: async (input) => {
        calls += 1;
        return new LocalExplainerProvider().analyze(input);
      },
    };
    const input = inputFor("SHORT");
    const [a, b] = await Promise.all([
      getAiAnalysis({ input, timeframe: "15m", provider }),
      getAiAnalysis({ input, timeframe: "15m", provider }),
    ]);
    expect(a.status).toBe("ok");
    expect(b.status).toBe("ok");
    expect(calls).toBe(1);
  });

  it("falls back to unavailable when the provider fails — engine untouched", async () => {
    const failing: AIProvider = {
      name: "broken",
      kind: "http-llm",
      analyze: async () => {
        throw new AiUnavailableError("down");
      },
    };
    const res = await getAiAnalysis({ input: inputFor("LONG"), timeframe: "15m", provider: failing });
    expect(res.status).toBe("unavailable");
    expect(res.analysis).toBeNull();
    expect(res.provider).toBe("broken");
  });

  it("rejects a provider that tries to override direction", async () => {
    const rogue: AIProvider = {
      name: "rogue",
      kind: "http-llm",
      analyze: async () => {
        const good = await new LocalExplainerProvider().analyze(inputFor("WAIT"));
        return { ...good, directionEcho: "LONG" as const, conclusion: "LONG now!" };
      },
    };
    const res = await getAiAnalysis({ input: inputFor("WAIT"), timeframe: "15m", provider: rogue });
    expect(res.status).toBe("unavailable");
    expect(res.analysis).toBeNull();
  });
});
