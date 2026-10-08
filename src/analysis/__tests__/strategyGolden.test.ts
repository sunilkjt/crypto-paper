import { describe, expect, it } from "vitest";
import { buildSignal } from "../signal";
import type { Candle } from "../../market/hyperliquid/types";
import { candlesFromCloses, downtrend, sideways, uptrend } from "./helpers";

/**
 * Golden strategy regression: locked engine outputs over fixed synthetic
 * histories. Any change to indicators, scoring, thresholds, rules, entry
 * formulas or closed-candle handling that moves these numbers FAILS loudly
 * here — that is the entire purpose of this file. Update expectations only
 * with a deliberate, reviewed strategy decision (never to silence CI).
 */

function mtf(closes: number[]): Record<string, Candle[]> {
  const c = candlesFromCloses(closes);
  return { "15m": c, "5m": c.slice(-120), "1h": c, "4h": c };
}

describe("golden strategy outputs (locked)", () => {
  it("uptrend resolves to the locked LONG setup", () => {
    const { status, signal } = buildSignal({ symbol: "G", setupTimeframe: "15m", candlesByTf: mtf(uptrend()) });
    expect(status).toBe("OK");
    expect(signal.direction).toBe("LONG");
    expect(signal.signalStrength).toBe(57.5);
    expect(signal.classification).toBe("WATCH");
    expect(signal.entryType).toBe("RETEST");
    expect(signal.entryStatus).toBe("WAIT_FOR_RETEST");
    expect(signal.timeframe).toBe("15m");
    expect(signal.timestamp).toBe(signal.dataTimestamp + 15 * 60_000);
  });

  it("downtrend resolves to the locked SHORT setup", () => {
    const { status, signal } = buildSignal({ symbol: "G", setupTimeframe: "15m", candlesByTf: mtf(downtrend()) });
    expect(status).toBe("OK");
    expect(signal.direction).toBe("SHORT");
    expect(signal.signalStrength).toBe(57.5);
    expect(signal.classification).toBe("WATCH");
    expect(signal.entryType).toBe("RETEST");
    expect(signal.entryStatus).toBe("WAIT_FOR_RETEST");
    expect(signal.timestamp).toBe(signal.dataTimestamp + 15 * 60_000);
  });

  it("sideways chop resolves to the locked WAIT (no plan, no entry state)", () => {
    const { status, signal } = buildSignal({ symbol: "G", setupTimeframe: "15m", candlesByTf: mtf(sideways()) });
    expect(status).toBe("OK");
    expect(signal.direction).toBe("WAIT");
    expect(signal.entryLow).toBeNull();
    expect(signal.entryType).toBeNull();
    expect(signal.entryStatus).toBeNull();
  });
});
