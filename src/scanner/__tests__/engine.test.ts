import { beforeEach, describe, expect, it, vi } from "vitest";
import { runFullScan, computeBreadth, rankSetups, type ScannedCoin } from "../engine";
import { applyEligibility } from "../eligibility";
import type { Market } from "../../market/hyperliquid/types";
import { candlesFromCloses, sideways, trendCandles, uptrend } from "../../analysis/__tests__/helpers";

const { mockCandles } = vi.hoisted(() => ({ mockCandles: vi.fn() }));

vi.mock("../../market/hyperliquid", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../market/hyperliquid")>();
  return { ...mod, getCachedCandles: mockCandles };
});

function market(symbol: string, volume: number): Market {
  return {
    symbol,
    markPrice: 100,
    oraclePrice: 100,
    dayVolumeNotional: volume,
    dayChangePct: 1,
    fundingRate: 0.0001,
    openInterestCoins: 100,
    openInterestNotional: 10000,
    prevDayPrice: 99,
    midPrice: 100,
  };
}

beforeEach(() => {
  mockCandles.mockReset();
  // BTC = stair up, ETH = stair down, OP = thin history, BAD = throws.
  mockCandles.mockImplementation(async (symbol: string, tf: string) => {
    const s = symbol.toUpperCase();
    if (s === "BAD") throw new Error("boom");
    let full: Record<string, unknown[]>;
    if (s === "BTC") {
      const c = trendCandles("up");
      const closes = c.map((x) => x.close);
      const plain = candlesFromCloses(closes);
      full = { "15m": c, "5m": plain.slice(-120), "1h": plain, "4h": plain };
    } else if (s === "ETH") {
      const c = trendCandles("down");
      const closes = c.map((x) => x.close);
      const plain = candlesFromCloses(closes);
      full = { "15m": c, "5m": plain.slice(-120), "1h": plain, "4h": plain };
    } else if (s === "OP") {
      full = { "15m": candlesFromCloses(uptrend(50)) } as Record<string, unknown[]>;
    } else {
      const c = candlesFromCloses(sideways());
      full = { "15m": c, "5m": c.slice(-120), "1h": c, "4h": c };
    }
    return { candles: full[tf] ?? full["15m"], updatedAt: Date.now() };
  });
});

describe("eligibility", () => {
  it("floors volume and caps the universe with reasons", () => {
    const markets = [market("BTC", 100_000_000), market("ETH", 80_000_000), market("OP", 10_000_000), market("DUST", 100)];
    const r = applyEligibility(markets, { minVolumeNotional: 250_000, universeSize: 2 });
    expect(r.eligible.map((m) => m.symbol)).toEqual(["BTC", "ETH"]);
    expect(r.excluded.map((e) => e.symbol).sort()).toEqual(["DUST", "OP"]);
    expect(r.excluded.find((e) => e.symbol === "DUST")?.reason).toMatch(/volume/);
    expect(r.excluded.find((e) => e.symbol === "OP")?.reason).toMatch(/top-2/);
  });
});

describe("runFullScan", () => {
  it("scores eligible markets and isolates per-coin failures", async () => {
    const markets = [market("BTC", 100_000_000), market("ETH", 80_000_000), market("BAD", 5_000_000), market("DUST", 100)];
    const summary = await runFullScan(markets, {
      eligibility: { minVolumeNotional: 250_000, universeSize: 10 },
      setupTimeframe: "15m",
      concurrency: 4,
    });
    expect(summary.status).toBe("COMPLETE");
    expect(summary.error).toBeNull();
    const symbols = summary.results.map((r) => r.symbol).sort();
    expect(symbols).toEqual(["BTC", "ETH"]);
    expect(summary.excluded.map((e) => e.symbol).sort()).toEqual(["BAD", "DUST"]);
    expect(summary.excluded.find((e) => e.symbol === "BAD")?.reason).toMatch(/boom/);
    const btc = summary.results.find((r) => r.symbol === "BTC");
    expect(btc?.signal.direction).toBe("LONG");
    expect(btc?.id).toContain("BTC|LONG|15m");
    expect(summary.scanned).toBe(2);
  });

  it("excludes thin candle history without failing the scan", async () => {
    const markets = [market("BTC", 100_000_000), market("OP", 10_000_000)];
    const summary = await runFullScan(markets, {
      eligibility: { minVolumeNotional: 250_000, universeSize: 10 },
      setupTimeframe: "15m",
      concurrency: 2,
    });
    expect(summary.status).toBe("COMPLETE");
    expect(summary.results.map((r) => r.symbol)).toEqual(["BTC"]);
    expect(summary.excluded.find((e) => e.symbol === "OP")?.reason).toMatch(/candles/);
  });

  it("completes empty input without error", async () => {
    const summary = await runFullScan([], {
      eligibility: { minVolumeNotional: 250_000, universeSize: 10 },
      setupTimeframe: "15m",
    });
    expect(summary.status).toBe("COMPLETE");
    expect(summary.results).toEqual([]);
    expect(summary.breadth.counted).toBe(0);
  });

  it("reports progress per coin", async () => {
    const seen: [number, number][] = [];
    await runFullScan([market("BTC", 100_000_000), market("ETH", 80_000_000)], {
      eligibility: { minVolumeNotional: 250_000, universeSize: 10 },
      setupTimeframe: "15m",
      concurrency: 2,
      onProgress: (done, total) => seen.push([done, total]),
    });
    expect(seen[seen.length - 1]).toEqual([2, 2]);
  });
});

describe("breadth and ranking", () => {
  it("computes breadth from scored signals only", () => {
    expect(computeBreadth([])).toEqual({ bullishPct: 0, bearishPct: 0, neutralPct: 0, counted: 0 });
    const rows = [
      { signal: { direction: "LONG" } },
      { signal: { direction: "LONG" } },
      { signal: { direction: "SHORT" } },
      { signal: { direction: "WAIT" } },
    ] as ScannedCoin[];
    expect(computeBreadth(rows)).toEqual({ bullishPct: 50, bearishPct: 25, neutralPct: 25, counted: 4 });
  });

  it("ranks directional setups before WAIT, strength first", () => {
    const rows = [
      { symbol: "A", signal: { direction: "WAIT", signalStrength: 99 } },
      { symbol: "B", signal: { direction: "SHORT", signalStrength: 60 } },
      { symbol: "C", signal: { direction: "LONG", signalStrength: 80 } },
    ] as ScannedCoin[];
    expect(rankSetups(rows).map((r) => r.symbol)).toEqual(["C", "B", "A"]);
  });
});
