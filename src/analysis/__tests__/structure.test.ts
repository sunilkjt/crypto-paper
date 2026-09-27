import { describe, expect, it } from "vitest";
import { lastAtr } from "../../indicators/atr";
import { detectSwings } from "../swings";
import { buildLevels } from "../levels";
import { classifyStructure } from "../structure";
import {
  candlesFromCloses,
  deadFloor,
  falseBreakoutUp,
  sideways,
  trendCandles,
  uptrend,
} from "./helpers";
import { efficiencyRatio } from "../structure";

describe("structure", () => {
  it("detects bullish HH/HL in an uptrend", () => {
    const candles = trendCandles("up");
    const atr = lastAtr(candles, 14) as number;
    const s = classifyStructure(candles, detectSwings(candles), atr);
    expect(s?.label).toBe("BULLISH");
    expect((s?.longScore as number)).toBeGreaterThan(s?.shortScore as number);
  });

  it("detects bearish LH/LL in a downtrend", () => {
    const candles = trendCandles("down");
    const atr = lastAtr(candles, 14) as number;
    const s = classifyStructure(candles, detectSwings(candles), atr);
    expect(s?.label).toBe("BEARISH");
    expect((s?.shortScore as number)).toBeGreaterThan(s?.longScore as number);
  });

  it("flags a false breakout instead of awarding it", () => {
    const candles = candlesFromCloses(falseBreakoutUp());
    const atr = lastAtr(candles, 14) as number;
    const s = classifyStructure(candles, detectSwings(candles), atr);
    expect(s?.falseBreakoutUp).toBe(true);
    expect((s?.longScore as number)).toBeLessThanOrEqual(0.25);
  });

  it("builds nearest + strong support under a holding floor", () => {
    const candles = candlesFromCloses(deadFloor());
    const closes = candles.map((c) => c.close);
    const price = closes[closes.length - 1];
    const atr = lastAtr(candles, 14) as number;
    const levels = buildLevels(detectSwings(candles), price, atr);
    expect(levels.nearestSupport).not.toBeNull();
    expect(levels.nearestSupport?.price).toBeLessThan(price);
    expect(levels.nearestSupport?.touches).toBeGreaterThanOrEqual(1);
    if (levels.strongSupport) {
      expect(levels.strongSupport.strength).toBeGreaterThanOrEqual(
        levels.nearestSupport?.strength ?? 0,
      );
    }
  });

  it("returns null without enough data", () => {
    const candles = candlesFromCloses([100, 101, 102]);
    expect(classifyStructure(candles, [], 1)).toBeNull();
    expect(buildLevels([], 100, 1).nearestSupport).toBeNull();
  });

  it("measures efficiency near 1 for trends, near 0 for chop", () => {
    expect(efficiencyRatio(uptrend()) as number).toBeGreaterThan(0.5);
    expect(efficiencyRatio(sideways()) as number).toBeLessThan(0.25);
  });
});
