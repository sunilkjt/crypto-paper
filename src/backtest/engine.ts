import { fetchHistoricalSet } from "./data";
import { simulateRange } from "./simulation";
import {
  buildEquityCurve,
  computeMetrics,
  directionBands,
  setupBands,
  strengthBands,
} from "./metrics";
import type {
  BacktestConfig,
  BacktestResult,
  BacktestTrade,
} from "./types";

/**
 * Backtest orchestrator: fetch → optional train/test split or walk-forward
 * windows → simulate (same deterministic engine as live) → metrics.
 * No parameter optimization exists, so training segments only provide
 * in-sample reference metrics — the strategy is never fitted to test data.
 */

export interface BacktestProgress {
  stage: "fetching" | "simulating" | "done";
  done: number;
  total: number;
  note: string;
}

export interface WindowDef {
  label: "IN-SAMPLE" | "OUT-OF-SAMPLE";
  start: number;
  end: number;
}

export function trainTestWindows(config: BacktestConfig): WindowDef[] {
  if (config.trainFraction >= 1) {
    return [{ label: "IN-SAMPLE", start: config.startDate, end: config.endDate }];
  }
  const cut = config.startDate + (config.endDate - config.startDate) * config.trainFraction;
  return [
    { label: "IN-SAMPLE", start: config.startDate, end: cut },
    { label: "OUT-OF-SAMPLE", start: cut, end: config.endDate },
  ];
}

export function walkForwardWindows(config: BacktestConfig): WindowDef[][] {
  if (config.walkTrainMs <= 0 || config.walkTestMs <= 0) return [];
  const pairs: WindowDef[][] = [];
  for (
    let trainStart = config.startDate;
    trainStart + config.walkTrainMs + config.walkTestMs <= config.endDate + 1;
    trainStart += config.walkTestMs
  ) {
    pairs.push([
      { label: "IN-SAMPLE", start: trainStart, end: trainStart + config.walkTrainMs },
      {
        label: "OUT-OF-SAMPLE",
        start: trainStart + config.walkTrainMs,
        end: trainStart + config.walkTrainMs + config.walkTestMs,
      },
    ]);
  }
  return pairs;
}

export async function runBacktest(
  config: BacktestConfig,
  onProgress?: (p: BacktestProgress) => void,
): Promise<BacktestResult> {
  validateConfig(config);
  onProgress?.({ stage: "fetching", done: 0, total: 1, note: `Loading ${config.timeframe} history…` });
  const set = await fetchHistoricalSet(
    config.symbol,
    config.timeframe,
    config.startDate,
    config.endDate,
    (done, total) => onProgress?.({ stage: "fetching", done, total, note: "Loading candles…" }),
  );
  if (set.candles.length < 220) {
    throw new Error(`Only ${set.candles.length} candles in range — need at least 220 for indicators.`);
  }

  const walkPairs = walkForwardWindows(config);
  const windows = walkPairs.length > 0 ? walkPairs : [trainTestWindows(config)];
  // Flat IN-SAMPLE ranges for labeling (walk-forward may have several).
  const inRanges = windows.flat().filter((w) => w.label === "IN-SAMPLE");
  const isInSample = (ts: number) => inRanges.some((r) => ts >= r.start && ts < r.end);

  const allTrades: BacktestTrade[] = [];
  let balance = config.startingBalance;
  let w = 0;
  for (const pair of windows) {
    w += 1;
    for (const window of pair) {
      const inWindow = set.candles.filter((c) => c.timestamp >= window.start && c.timestamp <= window.end);
      if (inWindow.length < 220) continue;
      onProgress?.({
        stage: "simulating",
        done: w - 1,
        total: windows.length,
        note: `${window.label}: replaying ${inWindow.length} bars…`,
      });
      // Warm-up prefix: signals need 211 bars of history, taken from just
      // before the window (still strictly ≤ each signal bar — no look-ahead).
      const startIdx = set.candles.findIndex((c) => c.timestamp >= window.start);
      const warmStart = Math.max(0, startIdx - 220);
      const feed = set.candles.slice(warmStart).filter((c) => c.timestamp <= window.end);
      const { trades, endBalance } = await simulateRange({
        symbol: config.symbol,
        setupTimeframe: config.timeframe,
        candles: feed,
        fundingSamples: set.fundingSamples,
        config,
        balance,
        inSample: isInSample,
        onProgress: (p) =>
          onProgress?.({ stage: "simulating", done: w - 1 + p.bar / Math.max(1, p.bars), total: windows.length, note: `${window.label}…` }),
        shouldYield: (bar) => bar % 500 === 0,
      });
      allTrades.push(...trades);
      balance = endBalance;
    }
  }

  onProgress?.({ stage: "done", done: 1, total: 1, note: "Computing metrics…" });
  const metrics = computeMetrics(allTrades, config.startingBalance);
  return {
    config,
    trades: allTrades,
    metrics,
    equity: buildEquityCurve(allTrades, config.startingBalance),
    byStrength: strengthBands(allTrades),
    bySetup: setupBands(allTrades),
    byDirection: directionBands(allTrades),
    fundingAvailable: set.fundingAvailable,
    candlesUsed: set.candles.length,
    generatedAt: Date.now(),
  };
}

export function validateConfig(config: BacktestConfig): void {
  if (!config.symbol) throw new Error("Symbol is required.");
  if (!(config.endDate > config.startDate)) throw new Error("End date must be after start date.");
  if (!(config.startingBalance > 0)) throw new Error("Starting balance must be positive.");
  if (!(config.riskPerTrade > 0 && config.riskPerTrade <= 0.25)) {
    throw new Error("Risk per trade must be within (0, 25%].");
  }
  if (!(config.feeRate >= 0 && config.feeRate <= 0.01)) throw new Error("Fee rate out of range.");
  if (!(config.slippageRate >= 0 && config.slippageRate <= 0.01)) throw new Error("Slippage out of range.");
  if (!(config.leverage >= 1 && config.leverage <= 50)) throw new Error("Leverage must be 1–50.");
}
