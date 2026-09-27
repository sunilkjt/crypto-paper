import { describe, expect, it } from "vitest";
import { atrSeries, lastAtr, trueRanges } from "../atr";
import type { Candle } from "../../market/hyperliquid/types";

function c(o: number, h: number, l: number, cl: number, t = 0, v = 100): Candle {
  return { timestamp: t, open: o, high: h, low: l, close: cl, volume: v };
}

describe("atr", () => {
  it("computes true ranges with gaps (hand-checked)", () => {
    const candles = [c(10, 12, 9, 11, 1), c(11, 15, 10, 14, 2), c(14, 14.5, 12, 12.5, 3)];
    const tr = trueRanges(candles);
    expect(tr[0]).toBeCloseTo(3, 10); // 12-9
    expect(tr[1]).toBeCloseTo(5, 10); // max(5, |15-11|, |10-11|)
    expect(tr[2]).toBeCloseTo(2.5, 10); // max(2.5, |14.5-14|, |12-14|)
  });

  it("seeds with SMA then smooths (hand-checked, period 2)", () => {
    const candles = [c(10, 12, 9, 11, 1), c(11, 15, 10, 14, 2), c(14, 14.5, 12, 12.5, 3)];
    // TR = [3, 5, 2.5]; seed = (3+5)/2 = 4 at idx1; idx2 = (4*1+2.5)/2 = 3.25
    const out = atrSeries(candles, 2);
    expect(out[0]).toBeNull();
    expect(out[1]).toBeCloseTo(4, 10);
    expect(out[2]).toBeCloseTo(3.25, 10);
    expect(lastAtr(candles, 2)).toBeCloseTo(3.25, 10);
  });

  it("expands in volatile markets, compresses in ranges", () => {
    const calm = Array.from({ length: 30 }, (_, i) => c(100, 100.2, 99.8, 100, i));
    const wild = Array.from({ length: 30 }, (_, i) =>
      c(100, 100 + ((i * 37) % 9), 100 - ((i * 53) % 9), 100 + ((i * 29) % 7) - 3, i),
    );
    expect((lastAtr(wild) as number)).toBeGreaterThan(lastAtr(calm) as number);
  });

  it("returns nulls when history is insufficient", () => {
    expect(atrSeries([c(1, 2, 0.5, 1.5, 1)], 14)).toEqual([null]);
    expect(lastAtr([], 14)).toBeNull();
  });
});
