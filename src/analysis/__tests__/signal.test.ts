import { describe, expect, it } from "vitest";
import { buildSignal, isListableBounce } from "../signal";
import { detectBounce } from "../bounce";
import type { Candle } from "../../market/hyperliquid/types";
import {
  candlesFromCloses,
  deadFloor,
  rejectionWick,
  sideways,
  trendCandles,
  uptrend,
  vRecovery,
} from "./helpers";

function tf(closes: number[]): Record<string, Candle[]> {
  const c = candlesFromCloses(closes);
  return { "15m": c, "5m": c.slice(-120), "1h": c, "4h": c };
}

function tfStair(dir: "up" | "down"): Record<string, Candle[]> {
  const c = trendCandles(dir);
  const closes = c.map((x) => x.close);
  const plain = candlesFromCloses(closes);
  return { "15m": c, "5m": plain.slice(-120), "1h": plain, "4h": plain };
}

describe("signal end-to-end", () => {
  it("scores a bullish market LONG with a full trade plan", () => {
    const { status, signal } = buildSignal({ symbol: "TEST", setupTimeframe: "15m", candlesByTf: tfStair("up") });
    expect(status).toBe("OK");
    expect(signal.direction).toBe("LONG");
    expect(signal.signalStrength).toBeGreaterThanOrEqual(40);
    expect(signal.entryLow).not.toBeNull();
    expect(signal.tp1 as number).toBeLessThan(signal.tp2 as number);
    expect(signal.tp2 as number).toBeLessThan(signal.tp3 as number);
    expect(signal.riskReward as number).toBeGreaterThan(0);
    expect(signal.reasons.length).toBeGreaterThan(0);
    expect(signal.dataTimestamp).toBeGreaterThan(0);
  });

  it("scores a bearish market SHORT", () => {
    const { status, signal } = buildSignal({ symbol: "TEST", setupTimeframe: "15m", candlesByTf: tfStair("down") });
    expect(status).toBe("OK");
    expect(signal.direction).toBe("SHORT");
    expect(signal.tp1 as number).toBeGreaterThan(signal.tp2 as number);
    expect(signal.tp2 as number).toBeGreaterThan(signal.tp3 as number);
  });

  it("waits on sideways chop instead of forcing a trade", () => {
    const { signal } = buildSignal({ symbol: "TEST", setupTimeframe: "15m", candlesByTf: tf(sideways()) });
    expect(signal.direction).toBe("WAIT");
    expect(signal.entryLow).toBeNull();
  });

  it("detects an oversold-recovery bounce with reasons", () => {
    const { signal } = buildSignal({ symbol: "TEST", setupTimeframe: "15m", candlesByTf: tf(vRecovery()) });
    // Recovery must at least avoid a SHORT and surface bounce evidence.
    expect(signal.direction).not.toBe("SHORT");
    expect(signal.bounce).not.toBeNull();
    expect(signal.warnings.join(" ")).not.toMatch(/INSUFFICIENT/);
  });

  it("stays WAIT on a mid-bounce wick (mixed evidence, already extended)", () => {
    const { status, signal } = buildSignal({
      symbol: "TEST",
      setupTimeframe: "15m",
      candlesByTf: tf(rejectionWick()),
    });
    expect(status).toBe("OK");
    // Bounced 7% off the low into bearish higher-timeframe context: mixed.
    expect(signal.direction).toBe("WAIT");
    expect(signal.entryLow).toBeNull();
    expect(signal.warnings.length).toBeGreaterThan(0);
  });
  it("never calls LONG on a dead flat floor (downtrend intact)", () => {
    const { signal } = buildSignal({ symbol: "TEST", setupTimeframe: "15m", candlesByTf: tf(deadFloor()) });
    // Flat floor after a decline: no bounce evidence, trend still bearish.
    expect(signal.direction).not.toBe("LONG");
  });

  it("returns INSUFFICIENT DATA on short history, never numbers", () => {
    const { status, signal } = buildSignal({
      symbol: "TEST",
      setupTimeframe: "15m",
      candlesByTf: { "15m": candlesFromCloses(uptrend(50)) },
    });
    expect(status).toBe("INSUFFICIENT_DATA");
    expect(signal.direction).toBe("WAIT");
    expect(signal.entryLow).toBeNull();
    expect(signal.warnings.join(" ")).toMatch(/INSUFFICIENT DATA/);
  });

  it("lists only agreeing, strong bounces", () => {
    const { signal } = buildSignal({ symbol: "TEST", setupTimeframe: "15m", candlesByTf: tfStair("up") });
    // Uptrend continuation may or may not qualify as a bounce — rule must be consistent.
    if (isListableBounce(signal)) {
      expect(signal.bounce?.direction).toBe(signal.direction);
      expect(signal.signalStrength).toBeGreaterThanOrEqual(60);
    } else {
      expect(
        signal.direction === "WAIT" ||
          signal.signalStrength < 60 ||
          signal.bounce?.direction !== signal.direction ||
          (signal.bounce?.bounceScore ?? 0) < 50,
      ).toBe(true);
    }
  });

  it("bounce detector vetoes longs into strong higher-timeframe bears", () => {
    const { signal } = buildSignal({ symbol: "TEST", setupTimeframe: "15m", candlesByTf: tfStair("down") });
    // Either no LONG bounce, or explicit veto warning present.
    const longBounce = signal.bounce?.direction === "LONG" && (signal.bounce?.bounceScore ?? 0) >= 60;
    expect(longBounce).toBe(false);
  });

  it("bounce unit: requires multiple confirmations, not oversold alone", () => {
    const base = {
      price: 100,
      atr: 2,
      structure: {
        label: "BEARISH" as const,
        longScore: 0,
        shortScore: 0.5,
        brokeAbove: false,
        brokeBelow: false,
        retestHeldAbove: false,
        retestHeldBelow: false,
        falseBreakoutUp: false,
        falseBreakoutDown: false,
        lastSwingHigh: 110,
        lastSwingLow: 90,
      },
      volume: { label: "LOW" as const, score: 0.15, spike: false },
      levels: {
        nearestSupport: { price: 99.5, touches: 2, strength: 0.6 },
        strongSupport: { price: 95, touches: 3, strength: 0.7 },
        nearestResistance: { price: 110, touches: 1, strength: 0.4 },
        strongResistance: null,
      },
      mtf: {
        tfs: [],
        longScore: 0.2,
        shortScore: 0.6,
        conflict: false,
        warnings: [],
      },
      supportDistanceAtr: 0.25,
      resistanceDistanceAtr: 5,
    };
    // Oversold RSI but falling, no recovery, low volume → no LONG bounce.
    const noBounce = detectBounce({
      ...base,
      momentum: {
        label: "NEGATIVE" as const,
        longScore: 0.1,
        shortScore: 0.6,
        recovering: false,
        fading: false,
      },
    });
    expect(noBounce.direction).not.toBe("LONG");
    // Same location WITH recovery + volume + LTF turn → LONG bounce.
    const yesBounce = detectBounce({
      ...base,
      momentum: {
        label: "POSITIVE" as const,
        longScore: 0.7,
        shortScore: 0.2,
        recovering: true,
        fading: false,
      },
      volume: { label: "HIGH" as const, score: 0.9, spike: true },
      mtf: {
        tfs: [{ timeframe: "5m", trend: "BULLISH", agreement: 0.6, flavor: "BULLISH_REVERSAL" }],
        longScore: 0.6,
        shortScore: 0.1,
        conflict: false,
        warnings: [],
      },
    });
    expect(yesBounce.direction).toBe("LONG");
    expect(yesBounce.bounceScore).toBeGreaterThanOrEqual(50);
    expect(yesBounce.bounceReasons.length).toBeGreaterThanOrEqual(3);
  });
});
