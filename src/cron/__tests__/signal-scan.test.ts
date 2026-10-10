import { describe, expect, it } from "vitest";

// The Supabase-native 5-minute trigger must invoke the FULL scheduled
// pipeline (signal-scan), never the read-only manual endpoint
// (telegram-scan). These tests pin the scheduled function's settings
// contract: same defaults as the retired GitHub cron schedule.
import { readSettings } from "../../../supabase/functions/signal-scan/handler.src";

describe("signal-scan scheduled settings", () => {
  it("defaults match the GitHub cron workflow it replaces", () => {
    const s = readSettings({});
    expect(s.categories).toEqual(["crypto", "stocks", "commodities"]);
    expect(s.minStrength).toBe(70);
    expect(s.directions).toEqual(["LONG", "SHORT"]);
    expect(s.cooldownMs).toBe(30 * 60_000);
    expect(s.universeCap).toBe(60);
    expect(s.concurrency).toBe(5);
  });

  it("accepts pg_cron/manual overrides without breaking defaults", () => {
    const s = readSettings({
      SCAN_CATEGORIES: "crypto",
      NOTIFY_MIN_STRENGTH: "80",
      NOTIFY_DIRECTIONS: "LONG",
      NOTIFY_COOLDOWN_MINUTES: "15",
      UNIVERSE_CAP: "20",
      SCAN_CONCURRENCY: "3",
    });
    expect(s.categories).toEqual(["crypto"]);
    expect(s.minStrength).toBe(80);
    expect(s.directions).toEqual(["LONG"]);
    expect(s.cooldownMs).toBe(15 * 60_000);
    expect(s.universeCap).toBe(20);
    expect(s.concurrency).toBe(3);
  });

  it("falls back to safe defaults on garbage input (never a dead scanner)", () => {
    const s = readSettings({
      SCAN_CATEGORIES: "nope",
      NOTIFY_MIN_STRENGTH: "55",
      NOTIFY_DIRECTIONS: "",
    });
    expect(s.categories).toEqual(["crypto", "stocks", "commodities"]);
    expect(s.minStrength).toBe(70);
    expect(s.directions).toEqual(["LONG", "SHORT"]);
  });
});
