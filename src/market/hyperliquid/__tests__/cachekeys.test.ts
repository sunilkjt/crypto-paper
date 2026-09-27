import { describe, expect, it } from "vitest";
import { candleCacheKey } from "../index";

describe("candleCacheKey", () => {
  it("snaps nearby millisecond windows to one grid key (shared reuse)", () => {
    const a = candleCacheKey("BTC", "15m", 1_700_000_000_123, 1_700_010_000_456);
    const b = candleCacheKey("btc", "15m", 1_700_000_001_000, 1_700_010_001_999);
    expect(a).toBe(b);
    expect(a).toContain("BTC");
    expect(a).toContain("15m");
  });

  it("separates timeframes, symbols and distant windows", () => {
    const base = candleCacheKey("BTC", "15m", 1_700_000_000_000, 1_700_010_000_000);
    expect(candleCacheKey("BTC", "1h", 1_700_000_000_000, 1_700_010_000_000)).not.toBe(base);
    expect(candleCacheKey("ETH", "15m", 1_700_000_000_000, 1_700_010_000_000)).not.toBe(base);
    expect(candleCacheKey("BTC", "15m", 1_800_000_000_000, 1_800_010_000_000)).not.toBe(base);
  });

  it("aligns exactly on grid boundaries", () => {
    const grid = 15 * 60_000;
    const t = 1_700_000_000_000 - (1_700_000_000_000 % grid);
    expect(candleCacheKey("OP", "15m", t, t + grid)).toBe(`hl:candles:OP:15m:${t}:${t + grid}`);
  });
});
