import { describe, expect, it } from "vitest";
import {
  getCandleWindow,
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
});
