import { describe, expect, it } from "vitest";
import { lastMacd, macdSeries } from "../macd";

describe("macd", () => {
  it("is zero on flat data and null when unready", () => {
    const flat = new Array(60).fill(10);
    const last = lastMacd(flat);
    expect(last.line).toBeCloseTo(0, 10);
    expect(last.signal).toBeCloseTo(0, 10);
    expect(last.histogram).toBeCloseTo(0, 10);

    const short = macdSeries([1, 2, 3, 4, 5], 3, 5, 2);
    // EMA3[4] = 4, EMA5[4] = 3 → line 1.0; signal needs 2 line values
    expect(short[4].line).toBeCloseTo(1.0, 10);
    expect(short[4].signal).toBeNull();
    expect(short[4].histogram).toBeNull();
  });

  it("turns histogram positive in a sustained rally", () => {
    const closes = [...new Array(40).fill(100), ...Array.from({ length: 40 }, (_, i) => 100 + i * 2)];
    const last = lastMacd(closes);
    expect(last.histogram).not.toBeNull();
    expect(last.histogram as number).toBeGreaterThan(0);
    expect(last.line as number).toBeGreaterThan(last.signal as number);
  });

  it("turns histogram negative in a sustained selloff", () => {
    const closes = [...new Array(40).fill(100), ...Array.from({ length: 40 }, (_, i) => 100 - i * 2)];
    const last = lastMacd(closes);
    expect(last.histogram).not.toBeNull();
    expect(last.histogram as number).toBeLessThan(0);
  });
});
