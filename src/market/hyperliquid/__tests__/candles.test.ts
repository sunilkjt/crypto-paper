import { describe, expect, it } from "vitest";
import { normalizeCandle, normalizeCandles, normalizeWsCandle } from "../candles";
import { HyperliquidError } from "../types";

const RAW = [
  { t: 3000, T: 3059, s: "OP", i: "1m", o: "2.2", h: "2.3", l: "2.1", c: "2.25", v: "100", n: 10 },
  { t: 1000, T: 1059, s: "OP", i: "1m", o: "2.0", h: "2.1", l: "1.9", c: "2.05", v: "50", n: 5 },
  { t: 2000, T: 2059, s: "OP", i: "1m", o: "2.05", h: "2.2", l: "2.0", c: "2.2", v: "75", n: 7 },
];

describe("normalizeCandle", () => {
  it("converts string numerics to numbers", () => {
    const c = normalizeCandle(RAW[0]);
    expect(c).toEqual({
      timestamp: 3000,
      open: 2.2,
      high: 2.3,
      low: 2.1,
      close: 2.25,
      volume: 100,
    });
  });

  it("throws invalid-response on corrupt fields", () => {
    expect(() =>
      normalizeCandle({ t: 1, T: 2, s: "OP", i: "1m", o: "bad", h: "1", l: "1", c: "1", v: "1", n: 1 }),
    ).toThrow(HyperliquidError);
  });
});

describe("normalizeWsCandle", () => {
  it("normalizes numeric WS candles", () => {
    const c = normalizeWsCandle({ t: 1, T: 2, s: "op", i: "15m", o: 1, c: 2, h: 3, l: 0.5, v: 10, n: 2 });
    expect(c.timestamp).toBe(1);
    expect(c.close).toBe(2);
    expect(c.volume).toBe(10);
  });
});

describe("normalizeCandles", () => {
  it("sorts ascending and dedupes by timestamp", () => {
    const withDup = [...RAW, { ...RAW[0] }];
    const out = normalizeCandles(withDup);
    expect(out.map((c) => c.timestamp)).toEqual([1000, 2000, 3000]);
  });

  it("skips single corrupt candles instead of failing the batch", () => {
    const out = normalizeCandles([...RAW, { t: 4000, o: "bad" } as never]);
    expect(out.map((c) => c.timestamp)).toEqual([1000, 2000, 3000]);
  });

  it("throws on non-array payloads", () => {
    expect(() => normalizeCandles({})).toThrow(HyperliquidError);
  });
});
