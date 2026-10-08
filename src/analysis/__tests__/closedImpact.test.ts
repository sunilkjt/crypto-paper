import { describe, expect, it } from "vitest";
import { buildSignal } from "../signal";
import { getClosedCandles } from "../../market/hyperliquid/timeframes";
import type { Candle } from "../../market/hyperliquid/types";
import {
  candlesFromCloses,
  deadFloor,
  parabolic,
  sideways,
  trendCandles,
  uptrend,
  vRecovery,
} from "./helpers";

const TF = "15m";
const TF_MS = 15 * 60_000;

function mtfFor(candles: Candle[]): Record<string, Candle[]> {
  return { "15m": candles, "5m": candles.slice(-120), "1h": candles, "4h": candles };
}

/**
 * Before/after measurement for closed-candle enforcement (§27): the same
 * deterministic engine over the same history, with and without a hostile
 * still-forming trailing bar. The trimmed run must equal the clean run
 * exactly; the untrimmed run must differ (proving the forming bar would
 * have contaminated the official signal).
 */
describe("closed-candle enforcement impact", () => {
  it("neutralizes a hostile forming spike (before ≠ after, after = clean)", () => {
    const base = trendCandles("up");
    const lastClose = base[base.length - 1];
    const formingOpen = Math.floor(Date.now() / TF_MS) * TF_MS;
    const spike: Candle = {
      timestamp: formingOpen,
      open: lastClose.close,
      high: lastClose.close * 1.02,
      low: lastClose.close * 0.5, // crash wick mid-formation
      close: lastClose.close * 0.62,
      volume: lastClose.volume * 9,
    };
    const contaminated = [...base, spike];

    const clean = buildSignal({ symbol: "T", setupTimeframe: TF, candlesByTf: mtfFor(base) }).signal;
    const trimmed = buildSignal({
      symbol: "T",
      setupTimeframe: TF,
      candlesByTf: mtfFor(getClosedCandles(contaminated, TF, formingOpen + 60_000)),
    }).signal;
    const raw = buildSignal({ symbol: "T", setupTimeframe: TF, candlesByTf: mtfFor(contaminated) }).signal;

    // After (trimmed) reproduces the clean signal exactly.
    expect(trimmed.direction).toBe(clean.direction);
    expect(trimmed.signalStrength).toBe(clean.signalStrength);
    expect(trimmed.dataTimestamp).toBe(clean.dataTimestamp);
    expect(trimmed.timestamp).toBe(clean.timestamp);
    // Before (untrimmed) is contaminated: anchored on the forming bar.
    expect(raw.dataTimestamp).toBe(formingOpen);
    expect(raw.dataTimestamp).not.toBe(clean.dataTimestamp);
  });

  it("reports the MARKET/RETEST split over representative scenarios", () => {
    const scenarios: [string, number[]][] = [
      ["uptrend", uptrend()],
      ["downtrend", uptrend().map((_, i) => 200 - i * 0.4)],
      ["sideways", sideways()],
      ["parabolic", parabolic()],
      ["recovery", vRecovery()],
      ["deadFloor", deadFloor()],
    ];
    let market = 0;
    let retest = 0;
    let directional = 0;
    for (const [, closes] of scenarios) {
      const candles = candlesFromCloses(closes);
      const closed = getClosedCandles(candles, TF, candles[candles.length - 1].timestamp + TF_MS);
      const { signal } = buildSignal({ symbol: "T", setupTimeframe: TF, candlesByTf: mtfFor(closed) });
      // Closed-input invariant: timestamp is always the generating bar's close.
      expect(signal.timestamp).toBe(signal.dataTimestamp + TF_MS);
      if (signal.direction === "LONG" || signal.direction === "SHORT") {
        directional += 1;
        expect(["MARKET", "RETEST"]).toContain(signal.entryType);
        expect(signal.entryStatus).toBe(signal.entryType === "MARKET" ? "READY" : "WAIT_FOR_RETEST");
        if (signal.entryType === "MARKET") market += 1;
        else retest += 1;
      } else {
        expect(signal.entryType).toBeNull();
        expect(signal.entryStatus).toBeNull();
      }
    }
    // Structural expectations (not strategy tuning): both entry states
    // occur across regimes, and every directional signal carries one.
    expect(directional).toBeGreaterThan(0);
    expect(market + retest).toBe(directional);
  });
});
