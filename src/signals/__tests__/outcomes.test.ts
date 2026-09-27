import { describe, expect, it } from "vitest";
import { trackOutcome } from "../outcomes";
import { candlesFromCloses } from "../../analysis/__tests__/helpers";

describe("outcomes", () => {
  it("tracks TP touches, MFE/MAE and timing on a winning long", () => {
    // Entry 100, risk 5 (inv 95), TPs 105/110/115. Rallies to 112 then fades.
    const closes = [100, 102, 104, 106, 108, 110, 112, 109, 107, 105];
    const candles = candlesFromCloses(closes, { start: 1000, stepMs: 60_000 });
    const out = trackOutcome({
      direction: "LONG",
      entryMid: 100,
      risk: 5,
      invalidation: 95,
      tp1: 105,
      tp2: 110,
      tp3: 115,
      followCandles: candles,
    });
    expect(out.tp1Reached).toBe(true);
    expect(out.tp2Reached).toBe(true);
    expect(out.tp3Reached).toBe(false);
    expect(out.invalidationReached).toBe(false);
    expect(out.mfeR).toBeGreaterThanOrEqual(2);
    expect(out.maeR).toBeLessThanOrEqual(0);
    expect(out.timeToTp1Ms).not.toBeNull();
    expect(out.timeToInvalidationMs).toBeNull();
    expect(out.barsObserved).toBe(closes.length);
  });

  it("records invalidation on a failed short", () => {
    // Short entry 100, inv 105. Squeezes to 107.
    const closes = [100, 101, 103, 105, 107, 106];
    const candles = candlesFromCloses(closes, { start: 1000, stepMs: 60_000 });
    const out = trackOutcome({
      direction: "SHORT",
      entryMid: 100,
      risk: 5,
      invalidation: 105,
      tp1: 95,
      tp2: 90,
      tp3: 85,
      followCandles: candles,
    });
    expect(out.invalidationReached).toBe(true);
    expect(out.tp1Reached).toBe(false);
    expect(out.timeToInvalidationMs).not.toBeNull();
  });

  it("returns zeros without follow-up or risk", () => {
    const out = trackOutcome({
      direction: "LONG",
      entryMid: 100,
      risk: 0,
      invalidation: 95,
      tp1: 105,
      tp2: 110,
      tp3: 115,
      followCandles: candlesFromCloses([101, 102]),
    });
    expect(out.tp1Reached).toBe(false);
    expect(out.mfeR).toBe(0);
    expect(out.barsObserved).toBe(2);
  });
});
