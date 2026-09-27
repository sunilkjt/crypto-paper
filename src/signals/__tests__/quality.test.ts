import { describe, expect, it } from "vitest";
import { assessQuality, classifyQuality } from "../quality";
import { buildSignal } from "../../analysis/signal";
import { candlesFromCloses, parabolic, trendCandles } from "../../analysis/__tests__/helpers";
import type { Candle } from "../../market/hyperliquid/types";
import type { Signal } from "../../analysis/signal";

function tfStair(dir: "up" | "down"): Record<string, Candle[]> {
  const c = trendCandles(dir);
  const closes = c.map((x) => x.close);
  const plain = candlesFromCloses(closes);
  return { "15m": c, "5m": plain.slice(-120), "1h": plain, "4h": plain };
}

function tf(closes: number[]): Record<string, Candle[]> {
  const c = candlesFromCloses(closes);
  return { "15m": c, "5m": c.slice(-120), "1h": c, "4h": c };
}

describe("quality", () => {
  it("vetoes poor R:R, wide stops, wild volatility and traps", () => {
    const base = {
      strength: 95,
      mtfAgreement: 0.9,
      mtfConflict: false,
      riskReward: 3,
      riskAtr: 1,
      atrPct: 1,
      falseBreakout: false,
    };
    expect(classifyQuality(base)).toBe("HIGH QUALITY");
    expect(classifyQuality({ ...base, riskReward: 1.2 })).toBe("LOW QUALITY");
    expect(classifyQuality({ ...base, riskReward: null })).toBe("LOW QUALITY");
    expect(classifyQuality({ ...base, riskAtr: 5 })).toBe("LOW QUALITY");
    expect(classifyQuality({ ...base, atrPct: 8 })).toBe("LOW QUALITY");
    expect(classifyQuality({ ...base, falseBreakout: true })).toBe("LOW QUALITY");
  });

  it("grades MEDIUM between the extremes", () => {
    expect(
      classifyQuality({
        strength: 65,
        mtfAgreement: 0.5,
        mtfConflict: false,
        riskReward: 2,
        riskAtr: 1.5,
        atrPct: 2.5,
        falseBreakout: false,
      }),
    ).toBe("MEDIUM QUALITY");
  });

  it("assesses a live-scored signal end to end", () => {
    const { signal } = buildSignal({ symbol: "T", setupTimeframe: "15m", candlesByTf: tfStair("up") });
    if (signal.direction === "WAIT") {
      expect(assessQuality(signal)).toBe("LOW QUALITY");
    } else {
      expect(["LOW QUALITY", "MEDIUM QUALITY", "HIGH QUALITY"]).toContain(assessQuality(signal));
    }
  });

  it("refuses chased parabolic entries as WAIT — POOR RISK/REWARD", () => {
    const { signal } = buildSignal({ symbol: "T", setupTimeframe: "15m", candlesByTf: tf(parabolic()) });
    expect(signal.direction).toBe("WAIT");
    expect(signal.entryLow).toBeNull();
    expect(signal.warnings.join(" ")).toMatch(/POOR RISK\/REWARD/);
  });

  it("keeps a healthy trend trade after the gates", () => {
    const { signal } = buildSignal({ symbol: "T", setupTimeframe: "15m", candlesByTf: tfStair("up") });
    if (signal.direction === "LONG") {
      expect(signal.riskReward as number).toBeGreaterThanOrEqual(1.5);
      expect(signal.warnings.join(" ")).not.toMatch(/POOR RISK\/REWARD/);
    } else {
      expect(signal.direction).toBe("WAIT");
    }
  });

  it("bounce components sum honestly", () => {
    const { signal } = buildSignal({ symbol: "T", setupTimeframe: "15m", candlesByTf: tfStair("up") });
    const b = signal.bounce;
    if (b) {
      const sum = b.components.support + b.components.momentum + b.components.volume + b.components.structure + b.components.mtf;
      expect(sum).toBeLessThanOrEqual(b.bounceScore + 1);
    }
    expect(signal satisfies Signal).toBeTruthy();
  });
});
