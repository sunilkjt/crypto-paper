import { describe, expect, it } from "vitest";
import {
  closedBoundary,
  getCandleWindow,
  getClosedCandles,
  isCandleClosed,
  isSupportedTimeframe,
  timeframeToMs,
  toHyperliquidInterval,
} from "../timeframes";

describe("timeframes", () => {
  it("maps supported timeframes to Hyperliquid intervals", () => {
    expect(toHyperliquidInterval("1m")).toBe("1m");
    expect(toHyperliquidInterval("4h")).toBe("4h");
    expect(timeframeToMs("1h")).toBe(3_600_000);
    expect(timeframeToMs("4h")).toBe(14_400_000);
  });

  it("validates supported timeframes", () => {
    expect(isSupportedTimeframe("15m")).toBe(true);
    expect(isSupportedTimeframe("3m")).toBe(false);
    expect(isSupportedTimeframe("1d")).toBe(false);
  });

  it("builds a bounded window ending now", () => {
    const end = 1_700_000_000_000;
    const w = getCandleWindow("15m", end, 100);
    expect(w.endTime).toBe(end);
    expect(w.startTime).toBe(end - 100 * 15 * 60_000);
  });

  it("classifies forming vs closed candles on interval boundaries (UTC)", () => {
    // 15m bar 10:00→10:15 open time; closed exactly at 10:15.
    const open = Date.UTC(2026, 9, 7, 10, 0, 0);
    expect(isCandleClosed(open, "15m", open + 15 * 60_000)).toBe(true);
    expect(isCandleClosed(open, "15m", open + 15 * 60_000 - 1)).toBe(false);
    expect(isCandleClosed(open, "1h", open + 15 * 60_000)).toBe(false);
    expect(isCandleClosed(open, "4h", open + 14_400_000)).toBe(true);
    expect(isCandleClosed(Number.NaN, "15m", open)).toBe(false);
    expect(closedBoundary("15m", open + 7 * 60_000)).toBe(open);
  });

  it("excludes the forming 15m candle, keeps the closed one", () => {
    const b0 = Date.UTC(2026, 9, 7, 9, 45, 0);
    const b1 = Date.UTC(2026, 9, 7, 10, 0, 0);
    const mk = (timestamp: number) => ({ timestamp });
    // Now = 10:07 → 10:00 bar still forming.
    expect(getClosedCandles([mk(b0), mk(b1)], "15m", b1 + 7 * 60_000).map((c) => c.timestamp)).toEqual([b0]);
    // Now = 10:15 → both closed.
    expect(getClosedCandles([mk(b0), mk(b1)], "15m", b1 + 15 * 60_000)).toHaveLength(2);
    // History far in the past is untouched (hour-aligned 1h bars, now well past close).
    const h8 = Date.UTC(2026, 9, 7, 8, 0, 0);
    const h9b = Date.UTC(2026, 9, 7, 9, 0, 0);
    expect(getClosedCandles([mk(h8), mk(h9b)], "1h", h9b + 61 * 60_000)).toHaveLength(2);
    expect(getClosedCandles([], "15m", b1)).toEqual([]);
  });

  it("excludes forming 1h and 4h candles independently per timeframe", () => {
    const h9 = Date.UTC(2026, 9, 7, 9, 0, 0);
    const h10 = Date.UTC(2026, 9, 7, 10, 0, 0);
    const h4 = Date.UTC(2026, 9, 7, 4, 0, 0);
    const h8 = Date.UTC(2026, 9, 7, 8, 0, 0);
    const mk = (timestamp: number) => ({ timestamp });
    const now = h10 + 30 * 60_000; // 10:30
    expect(getClosedCandles([mk(h9), mk(h10)], "1h", now).map((c) => c.timestamp)).toEqual([h9]);
    // 4h bars 04:00→08:00 (closed) and 08:00→12:00 (forming at 10:30).
    expect(getClosedCandles([mk(h4), mk(h8)], "4h", now).map((c) => c.timestamp)).toEqual([h4]);
  });
});
