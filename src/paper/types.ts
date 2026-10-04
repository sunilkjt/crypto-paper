/**
 * Paper trading types. SIMULATION ONLY — no exchange order API exists
 * anywhere in this codebase, and none is ever called from here.
 */

export type PaperPositionStatus =
  | "OPEN"
  | "TP1 HIT"
  | "TP2 HIT"
  | "TP3 HIT"
  | "STOPPED"
  | "CLOSED";

export interface PaperConfig {
  startingBalance: number;
  /** Fraction of equity risked per trade, e.g. 0.01. */
  riskPerTrade: number;
  /** Per-side fee fraction. */
  feeRate: number;
  autoPaperTrading: boolean;
  /** Minimum strength for auto entries. */
  autoMinStrength: number;
  /**
   * Defensive guard: a position's notional may never exceed
   * `equity * maxNotionalToEquity`. Client-side safety only (not
   * persisted server-side); older snapshots fall back to the default.
   */
  maxNotionalToEquity?: number;
}

export const DEFAULT_MAX_NOTIONAL_TO_EQUITY = 5;

/** Minimum stop distance as a fraction of entry (5 bps). Tighter stops are rejected. */
export const MIN_STOP_DISTANCE_PCT = 0.0005;

export function maxNotionalOf(config: PaperConfig): number {
  const v = config.maxNotionalToEquity;
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : DEFAULT_MAX_NOTIONAL_TO_EQUITY;
}

export const DEFAULT_PAPER_CONFIG: PaperConfig = {
  startingBalance: 1000,
  riskPerTrade: 0.01,
  feeRate: 0.0005,
  autoPaperTrading: false,
  autoMinStrength: 75,
  maxNotionalToEquity: DEFAULT_MAX_NOTIONAL_TO_EQUITY,
};

export interface PaperPosition {
  id: string;
  symbol: string;
  timeframe: string;
  setupType: string;
  direction: "LONG" | "SHORT";
  entry: number;
  size: number;
  notional: number;
  margin: number;
  risk: number;
  invalidation: number;
  tp1: number;
  tp2: number;
  tp3: number;
  strength: number;
  status: PaperPositionStatus;
  thirdsRemaining: number;
  realized: number;
  fees: number;
  openedAt: number;
  closedAt: number | null;
  closeReason: string | null;
}

export interface PaperSnapshot {
  config: PaperConfig;
  balance: number;
  realizedPnl: number;
  feesPaid: number;
  positions: PaperPosition[];
  closedCount: number;
  wins: number;
  peakEquity: number;
  maxDrawdownPct: number;
  updatedAt: number;
}
