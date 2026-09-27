export {
  DEFAULT_BACKTEST_CONFIG,
  type BacktestConfig,
  type BacktestMetrics,
  type BacktestResult,
  type BacktestTrade,
  type EquityPoint,
  type HistoricalSet,
  type StrengthBucket,
  type TradeResult,
} from "./types";
export { fetchHistoricalCandles, fetchFundingHistory, fetchHistoricalSet } from "./data";
export { simulateRange, resampleCandles, type SimProgress, type SimulateArgs, type SimulateOutput } from "./simulation";
export {
  computeMetrics,
  buildEquityCurve,
  strengthBands,
  setupBands,
  directionBands,
} from "./metrics";
export {
  runBacktest,
  trainTestWindows,
  walkForwardWindows,
  validateConfig,
  type BacktestProgress,
  type WindowDef,
} from "./engine";
