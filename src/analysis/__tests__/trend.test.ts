import { describe, expect, it } from "vitest";
import { lastEma } from "../../indicators/ema";
import { classifyTrend } from "../trend";
import { candlesFromCloses, downtrend, uptrend } from "./helpers";

function emas(closes: number[]) {
  return {
    e20: lastEma(closes, 20),
    e50: lastEma(closes, 50),
    e200: lastEma(closes, 200),
  };
}

describe("trend", () => {
  it("labels a clean uptrend BULLISH or stronger", () => {
    const closes = uptrend();
    const { e20, e50, e200 } = emas(closes);
    const t = classifyTrend(closes[closes.length - 1], e20, e50, e200);
    expect(t).not.toBeNull();
    expect(["BULLISH", "STRONG BULLISH"]).toContain(t?.label);
    expect(t?.bullPoints).toBeGreaterThanOrEqual(4);
  });

  it("labels a clean downtrend BEARISH or stronger", () => {
    const closes = downtrend();
    const { e20, e50, e200 } = emas(closes);
    const t = classifyTrend(closes[closes.length - 1], e20, e50, e200);
    expect(["BEARISH", "STRONG BEARISH"]).toContain(t?.label);
    expect(t?.bearPoints).toBeGreaterThanOrEqual(4);
  });

  it("labels converged chop NEUTRAL (hand-checked stack)", () => {
    // price inside a converged stack: 2 bull points, 2 bear points.
    const t = classifyTrend(100, 100.1, 99.9, 100);
    expect(t?.label).toBe("NEUTRAL");
    expect(t?.bullPoints).toBe(2);
    expect(t?.bearPoints).toBe(2);
  });

  it("returns null on missing inputs (INSUFFICIENT DATA)", () => {
    expect(classifyTrend(100, null, 90, 80)).toBeNull();
    expect(classifyTrend(null, 1, 2, 3)).toBeNull();
  });

  it("uses the full EMA stack, not price alone", () => {
    // Price above EMA20 but stack inverted → cannot be strongly bullish.
    const t = classifyTrend(101, 100, 102, 103);
    expect(t?.label).not.toBe("STRONG BULLISH");
    expect(t?.bearPoints).toBeGreaterThan(t?.bullPoints ?? 0);
  });

  it("reads live-shaped candle arrays", () => {
    const candles = candlesFromCloses(uptrend(220));
    const closes = candles.map((c) => c.close);
    const t = classifyTrend(closes[closes.length - 1], lastEma(closes, 20), lastEma(closes, 50), lastEma(closes, 200));
    expect(["BULLISH", "STRONG BULLISH"]).toContain(t?.label);
  });
});
