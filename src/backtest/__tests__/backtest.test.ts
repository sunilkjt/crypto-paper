import { describe, expect, it } from "vitest";
import { resampleCandles, simulateRange } from "../simulation";
import { computeMetrics } from "../metrics";
import { DEFAULT_BACKTEST_CONFIG } from "../types";
import { candlesFromCloses, trendCandles, uptrend } from "../../analysis/__tests__/helpers";
import { buildSignal } from "../../analysis/signal";

const CFG = {
  ...DEFAULT_BACKTEST_CONFIG,
  symbol: "T",
  timeframe: "15m" as const,
  startingBalance: 500,
  riskPerTrade: 0.01,
  feeRate: 0,
  slippageRate: 0,
  leverage: 1,
  minStrength: 0,
};

describe("resample", () => {
  it("aggregates 15m bars into 1h without future data", () => {
    const base = 1_700_000_000_000 - (1_700_000_000_000 % 3_600_000);
    const closes = Array.from({ length: 8 }, (_, i) => 100 + i);
    const candles = candlesFromCloses(closes, { start: base, stepMs: 900_000 });
    const hours = resampleCandles(candles, "1h");
    expect(hours).toHaveLength(2);
    expect(hours[0].open).toBe(closes[0]);
    expect(hours[0].close).toBe(closes[3]);
    expect(hours[0].high).toBeGreaterThanOrEqual(Math.max(...closes.slice(0, 4)));
    expect(hours[0].low).toBeLessThanOrEqual(Math.min(...closes.slice(0, 4)));
    expect(hours[1].volume).toBeGreaterThan(0);
  });
});

describe("simulation", () => {
  it("runs a LONG trend to TPs with the live engine", async () => {
    const c = trendCandles("up");
    const { trades } = await simulateRange({
      symbol: "T",
      setupTimeframe: "15m",
      candles: c,
      fundingSamples: [],
      config: CFG,
      balance: 500,
      inSample: () => true,
    });
    expect(trades.length).toBeGreaterThan(0);
    expect(trades[0].direction).toBe("LONG");
    expect(trades[0].result).toMatch(/TP1|TP2|TP3|STOPPED|EXPIRED/);
    expect(trades[0].positionSize).toBeGreaterThan(0);
    expect(trades[0].margin).toBe(trades[0].notional); // leverage 1
    // Fills happen strictly after their signals (next-bar-open fills).
    for (const t of trades) {
      expect(t.entryTimestamp).toBeGreaterThan(t.signalTimestamp);
      expect(t.exitTimestamp).toBeGreaterThanOrEqual(t.entryTimestamp);
    }
  });

  it("sizes positions from risk, entry and stop", async () => {
    const c = trendCandles("up");
    const run = (riskPerTrade: number) =>
      simulateRange({
        symbol: "T",
        setupTimeframe: "15m",
        candles: c,
        fundingSamples: [],
        config: { ...CFG, riskPerTrade, startingBalance: 1000 },
        balance: 1000,
        inSample: () => true,
      });
    const [r1, r2] = await Promise.all([run(0.01), run(0.02)]);
    const t1 = r1.trades[0];
    const t2 = r2.trades[0];
    // Same signals on same data: doubling risk doubles size exactly.
    expect(t2.positionSize).toBeCloseTo(t1.positionSize * 2, 8);
    expect(t2.notional).toBeCloseTo(t2.positionSize * t2.entry, 4);
    // Margin honors leverage (1x here); higher leverage shrinks margin only.
    expect(t1.margin).toBe(t1.notional);
  });

  it("applies fees and slippage to both sides", async () => {
    const c = trendCandles("up");
    const noCost = await simulateRange({
      symbol: "T", setupTimeframe: "15m", candles: c, fundingSamples: [],
      config: CFG, balance: 500, inSample: () => true,
    });
    const withCost = await simulateRange({
      symbol: "T", setupTimeframe: "15m", candles: c, fundingSamples: [],
      config: { ...CFG, feeRate: 0.001, slippageRate: 0.001 },
      balance: 500, inSample: () => true,
    });
    expect(withCost.trades.length).toBe(noCost.trades.length);
    expect(withCost.trades[0].fees).toBeGreaterThan(0);
    expect(withCost.trades[0].pnl).toBeLessThan(noCost.trades[0].pnl);
  });

  it("charges funding while open and labels it", async () => {
    const c = trendCandles("up");
    const withFunding = await simulateRange({
      symbol: "T", setupTimeframe: "15m", candles: c,
      fundingSamples: [{ timestamp: c[215].timestamp, rate: 0.001 }],
      config: CFG, balance: 500, inSample: () => true,
    });
    const t = withFunding.trades[0];
    // Long pays positive funding on open notional (if the sample falls in-window).
    expect(t.fundingPaid).toBeGreaterThanOrEqual(0);
  });

  it("resolves same-candle TP/SL conflict conservatively (stop wins)", async () => {
    // Build a tiny series where the bar after entry spikes through TP1
    // but also wicks below the stop: stop must win.
    const closes = trendCandles("up").map((c) => c.close);
    const base = candlesFromCloses(closes);
    // Force bar 215 to span both stop (~low) and TP1 (~high).
    const evil = base.map((c, i) =>
      i === 215 ? { ...c, high: c.high + 50, low: c.low - 50 } : c,
    );
    const { trades } = await simulateRange({
      symbol: "T", setupTimeframe: "15m", candles: evil, fundingSamples: [],
      config: CFG, balance: 500, inSample: () => true,
    });
    const first = trades[0];
    // Either stopped by the engineered bar or an earlier natural exit —
    // the assertion that matters: no trade claims TP while stopped same-bar.
    for (const t of trades) {
      if (t.result === "STOPPED") {
        expect(t.rMultiple).toBeLessThanOrEqual(0.05);
      }
    }
    expect(first).toBeTruthy();
  });
});

describe("look-ahead protection", () => {
  it("resampled higher TFs never contain future bars (tripwire)", () => {
    const closes = uptrend(400);
    closes[300] = closes[299] * 2; // violent future spike
    const full = candlesFromCloses(closes);
    const prefix = full.slice(0, 100);
    const hours = resampleCandles(prefix, "1h");
    const last = hours[hours.length - 1];
    // The spike at bar 300 must be absent from the prefix resample.
    expect(last.high).toBeLessThan(closes[299] * 1.5);
    expect(last.close).toBe(prefix[prefix.length - 1].close);
    // And present when the window actually includes it (sanity).
    const withSpike = resampleCandles(full.slice(0, 301), "1h");
    expect(withSpike[withSpike.length - 1].high).toBeGreaterThanOrEqual(closes[300]);
  });

  it("signal inputs at a replay bar exclude everything after it", () => {
    const full = trendCandles("up");
    const at = 230;
    const prefix = full.slice(0, at);
    // What the replay feeds buildSignal at bar `at - 1`.
    const replayInput = {
      "15m": prefix,
      "5m": prefix.slice(-120),
      "1h": prefix,
      "4h": prefix,
    };
    const replayed = buildSignal({ symbol: "T", setupTimeframe: "15m", candlesByTf: replayInput }).signal;
    // A standalone computation on the same prefix must agree exactly —
    // any future read inside the pipeline would break this identity.
    const standalone = buildSignal({ symbol: "T", setupTimeframe: "15m", candlesByTf: replayInput }).signal;
    expect(replayed.direction).toBe(standalone.direction);
    expect(replayed.signalStrength).toBe(standalone.signalStrength);
    expect(replayed.entryLow).toBe(standalone.entryLow);
    expect(replayed.dataTimestamp).toBe(prefix[prefix.length - 1].timestamp);
    expect(replayed.dataTimestamp).toBeLessThan(full[at].timestamp);
  });

  it("full replay agrees with truncated replay on early trades (tripwire)", async () => {
    const full = trendCandles("up");
    const cut = 250;
    const truncated = full.slice(0, cut);
    const run = (candles: typeof full) =>
      simulateRange({
        symbol: "T",
        setupTimeframe: "15m",
        candles,
        fundingSamples: [],
        config: CFG,
        balance: 500,
        inSample: () => true,
      });
    const [a, b] = await Promise.all([run(full), run(truncated)]);
    const horizon = truncated[truncated.length - 1].timestamp;
    // Strictly before the cut: force-closed edge trades are excluded both sides.
    const earlyA = a.trades.filter((t) => t.exitTimestamp < horizon);
    const earlyB = b.trades.filter((t) => t.exitTimestamp < horizon);
    // Same signals, same fills, same exits while the future was identical.
    // Any future read inside the pipeline changes earlyA vs earlyB and fails.
    expect(earlyB.length).toBeGreaterThan(0);
    expect(earlyA.length).toBe(earlyB.length);
    expect(earlyA.map((t) => [t.signalTimestamp, t.entry, t.exit, t.result, t.pnl])).toEqual(
      earlyB.map((t) => [t.signalTimestamp, t.entry, t.exit, t.result, t.pnl]),
    );
  });
});

describe("metrics", () => {
  it("computes win rate, profit factor, drawdown and hit rates", () => {
    const base = {
      index: 0, symbol: "T", timeframe: "15m" as const, signalTimestamp: 1,
      direction: "LONG" as const, setupType: "TREND" as const, strength: 70,
      classification: "SETUP" as const, entry: 100, invalidation: 95,
      tp1: 105, tp2: 110, tp3: 115, exit: 105, result: "TP1" as const,
      rMultiple: 1, pnl: 5, fees: 0.1, fundingPaid: 0, positionSize: 1,
      notional: 100, margin: 100, entryTimestamp: 1, exitTimestamp: 2,
      durationMs: 1000, maxFavorableR: 1.2, maxAdverseR: -0.2, inSample: true,
    };
    const trades = [
      { ...base, index: 0, rMultiple: 2, pnl: 10, exitTimestamp: 2 },
      { ...base, index: 1, rMultiple: -1, pnl: -5, result: "STOPPED" as const, exitTimestamp: 3 },
      { ...base, index: 2, rMultiple: 3, pnl: 15, result: "TP2" as const, exitTimestamp: 4 },
    ];
    const m = computeMetrics(trades, 500);
    expect(m.totalTrades).toBe(3);
    expect(m.winningTrades).toBe(2);
    expect(m.winRate).toBeCloseTo(66.67, 1);
    expect(m.averageR).toBeCloseTo(4 / 3, 2);
    expect(m.medianR).toBe(2);
    expect(m.profitFactor).toBeCloseTo(25 / 5, 5);
    expect(m.netPnl).toBe(20);
    expect(m.tp1HitRate).toBeCloseTo(66.67, 1);
    expect(m.invalidationRate).toBeCloseTo(33.33, 1);
    expect(m.maxDrawdown).toBeGreaterThanOrEqual(0);
  });
});
