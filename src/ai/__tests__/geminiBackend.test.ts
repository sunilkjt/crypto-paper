import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpAiProvider } from "../providers/httpProvider";
import { getAiAnalysis } from "../analyst";
import { clearAiCache } from "../cache";
import { resetRateLimitForTests } from "../ratelimit";
import type { AiAnalysisInput } from "../types";

const ENDPOINT = "https://ai.example.test/explain-signal";

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
    signalDirection: direction,
    signalStrength: direction === "WAIT" ? 20 : 86,
    entryLow: 108200,
    entryHigh: 108240,
    invalidation: 106800,
    tp1: 110500,
    tp2: 112000,
    tp3: 113500,
    riskReward: 1.64,
    signalReasons: ["Momentum recovering", "Volume confirmation"],
    signalWarnings: [],
    bounceScore: null,
    bounceDirection: null,
    marketDataTimestamp: 100,
    analysisTimestamp: 200,
    news: [],
  };
}

/** Valid edge-function-shaped analysis for the given engine direction. */
function edgeAnalysis(direction: "LONG" | "SHORT" | "WAIT") {
  return {
    summary: "Momentum is improving with bullish structure while volume supports the move.",
    marketStructure: "Higher timeframes aligned bullish.",
    setup: "15M framed setup.",
    confirmations: ["RSI recovering"],
    conflicts: [],
    risks: ["Invalidation ends the thesis."],
    invalidation: "A move through the stop ends the setup.",
    catalysts: [],
    conclusion: direction === "WAIT" ? "WAIT. No trade." : `${direction} per plan.`,
    directionEcho: direction,
  };
}

function okResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  clearAiCache();
  resetRateLimitForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Gemini edge-function contract (HttpAiProvider)", () => {
  it("accepts the { analysis } wrap and records the provider", async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
        seen.push(String(init?.body ?? ""));
        return okResponse({ analysis: edgeAnalysis("LONG") });
      }),
    );
    const out = await new HttpAiProvider(ENDPOINT).analyze(inputFor("LONG"));
    expect(out.directionEcho).toBe("LONG");
    expect(out.summary).toContain("Momentum");
  });

  it("accepts an unwrapped analysis object", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okResponse(edgeAnalysis("SHORT"))));
    const out = await new HttpAiProvider(ENDPOINT).analyze(inputFor("SHORT"));
    expect(out.directionEcho).toBe("SHORT");
  });

  it("rejects a conflicting direction echo — engine LONG stays LONG (no override)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okResponse(edgeAnalysis("SHORT"))));
    const res = await getAiAnalysis({
      input: inputFor("LONG"),
      timeframe: "15m",
      provider: new HttpAiProvider(ENDPOINT),
    });
    expect(res.status).toBe("unavailable");
    expect(res.analysis).toBeNull();
  });

  it("maps missing-key 503 and invalid JSON to unavailable (fallback path)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "not configured" }), { status: 503 })));
    const provider = new HttpAiProvider(ENDPOINT);
    const down = await getAiAnalysis({ input: inputFor("LONG"), timeframe: "15m", provider });
    expect(down.status).toBe("unavailable");

    resetRateLimitForTests();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not-json{{{", { status: 200 })));
    const bad = await getAiAnalysis({ input: inputFor("LONG"), timeframe: "15m", provider });
    expect(bad.status).toBe("unavailable");
  });

  it("times out instead of hanging the UI", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: unknown, init?: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
          }),
      ),
    );
    const res = await getAiAnalysis({
      input: inputFor("LONG"),
      timeframe: "15m",
      provider: new HttpAiProvider(ENDPOINT),
      timeoutMs: 50,
    });
    expect(res.status).toBe("unavailable");
    expect(res.analysis).toBeNull();
  });

  it("makes a single attempt per call — no retry loops against the backend", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        return new Response("oops", { status: 500 });
      }),
    );
    const provider = new HttpAiProvider(ENDPOINT);
    await getAiAnalysis({ input: inputFor("LONG"), timeframe: "15m", provider });
    resetRateLimitForTests();
    await getAiAnalysis({ input: inputFor("LONG"), timeframe: "15m", provider });
    expect(calls).toBe(2);
  });

  it("sends signal/market facts only — never credentials of any kind", async () => {
    let body = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
        body = String(init?.body ?? "");
        return okResponse({ analysis: edgeAnalysis("LONG") });
      }),
    );
    await new HttpAiProvider(ENDPOINT).analyze(inputFor("LONG"));
    expect(body).toContain("BTC");
    expect(body).not.toMatch(/api[_-]?key|secret|password|token|seed|private|credential|supabase/i);
  });

  it("reuses the cached explanation for the same signal (one backend call)", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        return okResponse({ analysis: edgeAnalysis("LONG") });
      }),
    );
    const provider = new HttpAiProvider(ENDPOINT);
    const input = inputFor("LONG");
    const first = await getAiAnalysis({ input, timeframe: "15m", provider });
    const second = await getAiAnalysis({ input, timeframe: "15m", provider });
    expect(first.status).toBe("ok");
    expect(second.status).toBe("ok");
    expect(second.cached).toBe(true);
    expect(calls).toBe(1);
  });
});
