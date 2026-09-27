import { describe, expect, it } from "vitest";
import {
  FRESHNESS,
  formatLastUpdated,
  isMarketsStale,
  isStale,
} from "../freshness";

describe("freshness", () => {
  it("flags data older than the threshold as stale", () => {
    const now = 1_000_000;
    expect(isStale(now - 10_000, 60_000, now)).toBe(false);
    expect(isStale(now - 61_000, 60_000, now)).toBe(true);
  });

  it("treats missing timestamps as stale (never generate signals)", () => {
    expect(isStale(0, 60_000, 1_000_000)).toBe(true);
    expect(isStale(NaN, 60_000, 1_000_000)).toBe(true);
  });

  it("uses the markets threshold centrally", () => {
    const now = Date.now();
    expect(isMarketsStale(now - 10_000, now)).toBe(false);
    expect(isMarketsStale(now - FRESHNESS.marketsStaleAfterMs - 1, now)).toBe(true);
  });

  it("formats last-updated labels", () => {
    const now = 1_000_000;
    expect(formatLastUpdated(0, now)).toBe("Last updated: never");
    expect(formatLastUpdated(now - 500, now)).toBe("Last updated: just now");
    expect(formatLastUpdated(now - 5_000, now)).toBe("Last updated: 5 seconds ago");
    expect(formatLastUpdated(now - 120_000, now)).toBe("Last updated: 2 minutes ago");
  });
});
