import { describe, expect, it } from "vitest";
import { analyzeMtf } from "../mtf";
import { calculateSignalScore, classifyStrength } from "../scoring";
import { buildTradePlan } from "../tradeplan";

describe("scoring", () => {
  it("scores a clean bull near max with honest components", () => {
    const r = calculateSignalScore({
      trendLong: 1, trendShort: 0,
      momentumLong: 0.9, momentumShort: 0.1,
      volume: 0.8,
      structureLong: 0.9, structureShort: 0,
      mtfLong: 0.85, mtfShort: 0,
    });
    expect(r.direction).toBe("LONG");
    expect(r.score).toBeGreaterThanOrEqual(75);
    expect(r.components.trend).toBe(25);
    expect(r.components.momentum).toBeCloseTo(18, 5);
    expect(r.longScore).toBeGreaterThan(r.shortScore);
  });

  it("returns WAIT on low confluence or mixed evidence — never forced", () => {
    const low = calculateSignalScore({
      trendLong: 0.4, trendShort: 0.4,
      momentumLong: 0.3, momentumShort: 0.3,
      volume: 0.2,
      structureLong: 0.2, structureShort: 0.2,
      mtfLong: 0.3, mtfShort: 0.3,
    });
    expect(low.direction).toBe("WAIT");
    expect(low.classification).toBe("WAIT");

    const mixed = calculateSignalScore({
      trendLong: 0.8, trendShort: 0.75,
      momentumLong: 0.7, momentumShort: 0.65,
      volume: 0.8,
      structureLong: 0.7, structureShort: 0.7,
      mtfLong: 0.7, mtfShort: 0.68,
    });
    expect(mixed.direction).toBe("WAIT");
    expect(mixed.warnings.join(" ")).toMatch(/Mixed evidence/);
  });

  it("classifies strength bands exactly", () => {
    expect(classifyStrength(0)).toBe("WAIT");
    expect(classifyStrength(39.9)).toBe("WAIT");
    expect(classifyStrength(40)).toBe("WATCH");
    expect(classifyStrength(59.9)).toBe("WATCH");
    expect(classifyStrength(60)).toBe("SETUP");
    expect(classifyStrength(74.9)).toBe("SETUP");
    expect(classifyStrength(75)).toBe("STRONG SETUP");
    expect(classifyStrength(89.9)).toBe("STRONG SETUP");
    expect(classifyStrength(90)).toBe("HIGH-CONFLUENCE SETUP");
    expect(classifyStrength(100)).toBe("HIGH-CONFLUENCE SETUP");
  });
});

describe("mtf", () => {
  const bull = { trend: "BULLISH" as const, bullPoints: 4, bearPoints: 1, reversalUp: false, reversalDown: false };
  const strongBear = { trend: "BEARISH" as const, bullPoints: 0, bearPoints: 5, reversalUp: false, reversalDown: false };

  it("rewards alignment across 4h/1h/15m/5m", () => {
    const r = analyzeMtf({ "4h": bull, "1h": bull, "15m": bull, "5m": bull });
    expect(r.conflict).toBe(false);
    expect(r.longScore).toBeGreaterThan(0.5);
    expect(r.shortScore).toBeLessThan(0.2);
  });

  it("halves MTF on strong conflict and warns", () => {
    const fullBull = { trend: "BULLISH" as const, bullPoints: 5, bearPoints: 0, reversalUp: false, reversalDown: false };
    const aligned = analyzeMtf({ "4h": fullBull, "1h": fullBull, "15m": fullBull, "5m": fullBull });
    const conflicted = analyzeMtf({ "4h": strongBear, "1h": fullBull, "15m": fullBull, "5m": fullBull });
    expect(conflicted.conflict).toBe(true);
    expect(conflicted.longScore).toBeLessThan(aligned.longScore);
    expect(conflicted.warnings.join(" ")).toMatch(/conflict/i);
  });

  it("renormalizes when a timeframe is missing", () => {
    const r = analyzeMtf({ "1h": bull, "15m": bull });
    expect(r.warnings.length).toBeGreaterThan(0);
    expect(r.longScore).toBeGreaterThan(0);
  });

  it("labels a 15m pullback against a bullish 1h", () => {
    const r = analyzeMtf({
      "4h": bull,
      "1h": bull,
      "15m": { trend: "NEUTRAL" as const, bullPoints: 2, bearPoints: 2, reversalUp: false, reversalDown: false },
      "5m": { trend: "NEUTRAL" as const, bullPoints: 2, bearPoints: 2, reversalUp: true, reversalDown: false },
    });
    expect(r.tfs.find((t) => t.timeframe === "15m")?.flavor).toBe("PULLBACK");
    expect(r.tfs.find((t) => t.timeframe === "5m")?.flavor).toBe("BULLISH_REVERSAL");
  });
});

describe("tradeplan", () => {
  const levels = {
    nearestSupport: { price: 95, touches: 3, strength: 0.8 },
    strongSupport: { price: 93, touches: 4, strength: 0.9 },
    nearestResistance: { price: 105, touches: 2, strength: 0.6 },
    strongResistance: { price: 108, touches: 3, strength: 0.75 },
  };
  const structure = {
    label: "BULLISH" as const,
    longScore: 0.7,
    shortScore: 0,
    brokeAbove: false,
    brokeBelow: false,
    retestHeldAbove: false,
    retestHeldBelow: false,
    falseBreakoutUp: false,
    falseBreakoutDown: false,
    lastSwingHigh: 104,
    lastSwingLow: 94,
  };

  it("builds an ordered LONG plan with R:R", () => {
    const p = buildTradePlan({ direction: "LONG", price: 100, atr: 2, levels, structure });
    expect(p).not.toBeNull();
    expect(p?.entryLow).toBeLessThan(p?.entryHigh as number);
    expect(p?.invalidation).toBeLessThan(p?.entryLow as number);
    expect(p?.tp1).toBeLessThan(p?.tp2 as number);
    expect(p?.tp2).toBeLessThan(p?.tp3 as number);
    expect(p?.tp1 as number).toBeGreaterThan(p?.entryHigh as number);
    expect(p?.riskReward as number).toBeGreaterThan(1);
  });

  it("builds an ordered SHORT plan with R:R", () => {
    const p = buildTradePlan({ direction: "SHORT", price: 100, atr: 2, levels, structure });
    expect(p).not.toBeNull();
    expect(p?.entryLow).toBeLessThan(p?.entryHigh as number);
    expect(p?.invalidation).toBeGreaterThan(p?.entryHigh as number);
    expect((p?.tp1 as number)).toBeGreaterThan(p?.tp2 as number);
    expect((p?.tp2 as number)).toBeGreaterThan(p?.tp3 as number);
    expect(p?.tp1 as number).toBeLessThan(p?.entryLow as number);
    expect(p?.riskReward as number).toBeGreaterThan(1);
  });

  it("refuses plans without structure (never arbitrary)", () => {
    const empty = {
      nearestSupport: null,
      strongSupport: null,
      nearestResistance: null,
      strongResistance: null,
    };
    expect(
      buildTradePlan({ direction: "LONG", price: 100, atr: 2, levels: empty, structure: { ...structure, lastSwingLow: null } }),
    ).toBeNull();
  });
});
