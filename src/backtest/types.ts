import type { Candle, Timeframe } from "../market/hyperliquid/types";
import type { Direction, StrengthClass } from "../analysis/scoring";
import type { SetupType } from "../signals/setupType";

/**
 * Backtest types. All money math happens here on plain numbers —
 * no exchange APIs, no keys, no orders anywhere in this module.
 */

export interface BacktestConfig {
  symbol: string;
  timeframe: Timeframe;
  startDate: number;
  endDate: number;
  startingBalance: number;
  /** Fraction of equity risked per trade, e.g. 0.01 = 1%. */
  riskPerTrade: number;
  /** Per-side fee fraction, e.g. 0.0005 = 5 bps. Documented default. */
  feeRate: number;
  /** Per-side slippage fraction, e.g. 0.0005 = 0.05%. */
  slippageRate: number;
  /** Leverage scales exposure/margin only — never the edge. */
  leverage: number;
  /** Min signal strength to take a trade (default 60 = SETUP+). */
  minStrength: number;
  /** Train/test split: fraction of the period used for training (1 = all). */
  trainFraction: number;
  /** Walk-forward: fixed training window in ms (0 = disabled). */
  walkTrainMs: number;
  /** Walk-forward: fixed testing window in ms (0 = disabled). */
  walkTestMs: number;
}

export const DEFAULT_BACKTEST_CONFIG: BacktestConfig = {
  symbol: "OP",
  timeframe: "15m",
  startDate: 0,
  endDate: 0,
  startingBalance: 500,
  riskPerTrade: 0.01,
  feeRate: 0.0005, // 5 bps per side — documented, configurable
  slippageRate: 0.0005, // 0.05% per side — documented, configurable
  leverage: 1,
  minStrength: 60,
  trainFraction: 1,
  walkTrainMs: 0,
  walkTestMs: 0,
};

export type TradeResult = "TP1" | "TP2" | "TP3" | "STOPPED" | "EXPIRED";

export interface BacktestTrade {
  index: number;
  symbol: string;
  timeframe: Timeframe;
  signalTimestamp: number;
  direction: Exclude<Direction, "WAIT">;
  setupType: SetupType;
  strength: number;
  classification: StrengthClass;
  entry: number;
  invalidation: number;
  tp1: number;
  tp2: number;
  tp3: number;
  exit: number;
  result: TradeResult;
  /** Realized R multiple after fees/slippage/funding. */
  rMultiple: number;
  /** Realized PnL in account currency after all costs. */
  pnl: number;
  fees: number;
  fundingPaid: number;
  positionSize: number;
  notional: number;
  margin: number;
  entryTimestamp: number;
  exitTimestamp: number;
  durationMs: number;
  maxFavorableR: number;
  maxAdverseR: number;
  inSample: boolean;
}

export interface EquityPoint {
  timestamp: number;
  equity: number;
  drawdownPct: number;
}

export interface BacktestMetrics {
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  averageR: number;
  medianR: number;
  profitFactor: number;
  netPnl: number;
  returnPct: number;
  maxDrawdown: number;
  maxDrawdownPct: number;
  averageTrade: number;
  bestTrade: number;
  worstTrade: number;
  averageHoldingMs: number;
  tp1HitRate: number;
  tp2HitRate: number;
  tp3HitRate: number;
  invalidationRate: number;
}

export interface StrengthBucket {
  band: string;
  trades: number;
  wins: number;
  averageR: number;
}

export interface BacktestResult {
  config: BacktestConfig;
  trades: BacktestTrade[];
  metrics: BacktestMetrics;
  equity: EquityPoint[];
  byStrength: StrengthBucket[];
  bySetup: StrengthBucket[];
  byDirection: StrengthBucket[];
  fundingAvailable: boolean;
  candlesUsed: number;
  generatedAt: number;
}

export interface HistoricalSet {
  candles: Candle[];
  fundingAvailable: boolean;
  /** Funding rate per millisecond-indexed sample (aligned scan, may be sparse). */
  fundingSamples: { timestamp: number; rate: number }[];
}
