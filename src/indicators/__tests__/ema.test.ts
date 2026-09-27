import { describe, expect, it } from "vitest";
import { emaSeries, lastEma } from "../ema";

describe("ema", () => {
  it("computes SMA-seeded EMA (hand-checked, period 3)", () => {
    // seed = (10+11+12)/3 = 11, k = 0.5
    // e[3] = 13*0.5 + 11*0.5 = 12 ; e[4] = 14*0.5 + 12*0.5 = 13
    const out = emaSeries([10, 11, 12, 13, 14], 3);
    expect(out[0]).toBeNull();
    expect(out[1]).toBeNull();
    expect(out[2]).toBeCloseTo(11, 10);
    expect(out[3]).toBeCloseTo(12, 10);
    expect(out[4]).toBeCloseTo(13, 10);
    expect(lastEma([10, 11, 12, 13, 14], 3)).toBeCloseTo(13, 10);
  });

  it("returns nulls when history is insufficient or invalid", () => {
    expect(emaSeries([1, 2, 3], 5)).toEqual([null, null, null]);
    expect(emaSeries([], 3)).toEqual([]);
    expect(lastEma([1, 2], 10)).toBeNull();
    expect(lastEma([], 3)).toBeNull();
  });

  it("tracks an uptrend above price-turns and reacts to drops", () => {
    const up = Array.from({ length: 30 }, (_, i) => 100 + i);
    const e = lastEma(up, 20);
    expect(e).not.toBeNull();
    expect(e as number).toBeLessThan(100 + 29); // EMA lags price
    expect(e as number).toBeGreaterThan(100);
  });
});
