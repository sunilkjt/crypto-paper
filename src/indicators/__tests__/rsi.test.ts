import { describe, expect, it } from "vitest";
import { lastRsi, rsiSeries } from "../rsi";

describe("rsi", () => {
  it("computes Wilder RSI (hand-checked, period 3)", () => {
    // closes 10,11,10.5,12 → changes +1,-0.5,+1.5
    // avgGain = 2.5/3 ≈ 0.8333, avgLoss = 0.5/3 ≈ 0.1667, RS = 5
    // RSI = 100 - 100/6 ≈ 83.333
    const out = rsiSeries([10, 11, 10.5, 12], 3);
    expect(out[0]).toBeNull();
    expect(out[1]).toBeNull();
    expect(out[2]).toBeNull();
    expect(out[3]).toBeCloseTo(83.333, 2);
  });

  it("yields 100 for all-up, 0 for all-down, 50 for flat", () => {
    const up = Array.from({ length: 20 }, (_, i) => 100 + i);
    const down = Array.from({ length: 20 }, (_, i) => 100 - i);
    const flat = new Array(20).fill(50);
    expect(lastRsi(up, 14)).toBe(100);
    expect(lastRsi(down, 14)).toBe(0);
    expect(lastRsi(flat, 14)).toBe(50);
  });

  it("returns nulls when history is insufficient", () => {
    expect(rsiSeries([1, 2, 3], 14)).toEqual([null, null, null]);
    expect(lastRsi([1], 14)).toBeNull();
  });

  it("detects oversold recovery (28 → 35 style)", () => {
    const closes = [
      ...Array.from({ length: 15 }, (_, i) => 100 - i * 2), // grind down
      70, 71.5, 73, 74.5, 76, // recovery
    ];
    const s = rsiSeries(closes, 14);
    const trough = s[15];
    const now = s[s.length - 1];
    expect(trough).not.toBeNull();
    expect(now).not.toBeNull();
    expect((trough as number)).toBeLessThan(35);
    expect((now as number)).toBeGreaterThan(trough as number);
  });
});
