import { describe, expect, it } from "vitest";
import { classifySetupType, signalIdFor, stableSignalId } from "../setupType";
import { buildSignal } from "../../analysis/signal";
import { candlesFromCloses, trendCandles } from "../../analysis/__tests__/helpers";
import type { Candle } from "../../market/hyperliquid/types";

function tfStair(dir: "up" | "down"): Record<string, Candle[]> {
  const c = trendCandles(dir);
  const closes = c.map((x) => x.close);
  const plain = candlesFromCloses(closes);
  return { "15m": c, "5m": plain.slice(-120), "1h": plain, "4h": plain };
}

describe("deduplication", () => {
  it("mints stable IDs that change only on material setup change", () => {
    const id1 = stableSignalId({ symbol: "op", direction: "LONG", timeframe: "15m", setupType: "BOUNCE", anchorTimestamp: 100 });
    const id2 = stableSignalId({ symbol: "OP", direction: "LONG", timeframe: "15m", setupType: "BOUNCE", anchorTimestamp: 100 });
    expect(id1).toBe(id2);
    expect(id1).toBe("OP|LONG|15m|BOUNCE|100");
    expect(
      stableSignalId({ symbol: "OP", direction: "SHORT", timeframe: "15m", setupType: "BOUNCE", anchorTimestamp: 100 }),
    ).not.toBe(id1);
    expect(
      stableSignalId({ symbol: "OP", direction: "LONG", timeframe: "15m", setupType: "TREND", anchorTimestamp: 100 }),
    ).not.toBe(id1);
    expect(
      stableSignalId({ symbol: "OP", direction: "LONG", timeframe: "15m", setupType: "BOUNCE", anchorTimestamp: 200 }),
    ).not.toBe(id1);
  });

  it("returns null IDs for WAIT (nothing to dedupe)", () => {
    const { signal } = buildSignal({
      symbol: "T",
      setupTimeframe: "15m",
      candlesByTf: tfStair("up"),
    });
    if (signal.direction === "WAIT") {
      expect(signalIdFor(signal, "RANGE")).toBeNull();
    } else {
      const id = signalIdFor(signal, classifySetupType(signal));
      expect(id).toContain(signal.symbol);
      expect(id).toContain(signal.direction);
    }
  });

  it("classifies trend, pullback and range shapes", () => {
    const up = buildSignal({ symbol: "T", setupTimeframe: "15m", candlesByTf: tfStair("up") }).signal;
    const down = buildSignal({ symbol: "T", setupTimeframe: "15m", candlesByTf: tfStair("down") }).signal;
    for (const s of [up, down]) {
      const t = classifySetupType(s);
      expect(["BOUNCE", "BREAKOUT", "BREAKDOWN", "PULLBACK", "REVERSAL", "TREND", "RANGE"]).toContain(t);
      if (s.direction === "WAIT") expect(t).toBe("RANGE");
    }
    // Directional trend-following shape classifies as TREND, never RANGE-gated wrongly.
    if (up.direction === "LONG" && up.marketStructure === "BULLISH" && (up.bounce?.direction !== "LONG")) {
      expect(classifySetupType(up)).toBe("TREND");
    }
  });
});
