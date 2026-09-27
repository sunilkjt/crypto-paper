import { describe, expect, it } from "vitest";
import { volumeStats } from "../volume";

describe("volume", () => {
  it("computes average excluding the current bar (hand-checked)", () => {
    const vols = [...new Array(20).fill(100), 300];
    const s = volumeStats(vols, 20);
    expect(s).not.toBeNull();
    expect(s?.average).toBeCloseTo(100, 10);
    expect(s?.relative).toBeCloseTo(3, 10);
    expect(s?.spike).toBe(true);
  });

  it("flags normal and low regimes without spikes", () => {
    const normal = [...new Array(20).fill(100), 110];
    expect(volumeStats(normal, 20)?.spike).toBe(false);
    expect(volumeStats(normal, 20)?.relative).toBeCloseTo(1.1, 10);
    const low = [...new Array(20).fill(100), 40];
    expect(volumeStats(low, 20)?.spike).toBe(false);
    expect(volumeStats(low, 20)?.relative).toBeCloseTo(0.4, 10);
  });

  it("returns null on insufficient or corrupt data", () => {
    expect(volumeStats(new Array(20).fill(100), 20)).toBeNull(); // needs 21
    expect(volumeStats([], 20)).toBeNull();
    expect(volumeStats([...new Array(20).fill(0), 100], 20)).toBeNull(); // zero avg
  });
});
