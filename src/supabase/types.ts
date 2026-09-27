/**
 * Supabase row shapes for cloud paper trading. PAPER ONLY.
 * Mirrors supabase/migrations/0001_paper_trading.sql.
 */

export interface PaperAccountRow {
  id: string;
  user_id: string;
  starting_balance: number;
  current_balance: number;
  realized_pnl: number;
  fees_paid: number;
  closed_count: number;
  wins: number;
  peak_equity: number;
  max_drawdown_pct: number;
  risk_per_trade: number;
  fee_rate: number;
  auto_paper_trading: boolean;
  auto_min_strength: number;
  created_at: string;
  updated_at: string;
}

export interface PaperPositionRow {
  id: string;
  account_id: string;
  user_id: string;
  symbol: string;
  side: "LONG" | "SHORT";
  quantity: number;
  leverage: number;
  entry_price: number;
  current_price: number | null;
  stop_loss: number | null;
  take_profit: number | null;
  unrealized_pnl: number;
  status: string;
  opened_at: string;
  updated_at: string;
  timeframe: string | null;
  setup_type: string | null;
  tp1: number | null;
  tp2: number | null;
  tp3: number | null;
  invalidation: number | null;
  strength: number | null;
  thirds_remaining: number | null;
  realized: number | null;
  fees: number | null;
  notional: number | null;
  margin: number | null;
  risk: number | null;
  close_reason: string | null;
  closed_at: string | null;
}

export interface PaperTradeRow {
  id: string;
  account_id: string;
  user_id: string;
  symbol: string;
  side: "LONG" | "SHORT";
  quantity: number;
  leverage: number;
  entry_price: number;
  exit_price: number | null;
  stop_loss: number | null;
  take_profit: number | null;
  fees: number;
  funding: number;
  realized_pnl: number;
  result: string | null;
  signal_id: string | null;
  opened_at: string;
  closed_at: string | null;
  created_at: string;
  timeframe: string | null;
  setup_type: string | null;
  tp1: number | null;
  tp2: number | null;
  tp3: number | null;
  strength: number | null;
  close_reason: string | null;
}

export type CloudSyncStatus =
  | "disabled" // Supabase env not configured -> pure local mode.
  | "signed-out" // Configured but no user -> local only.
  | "loading" // Restoring session / first fetch.
  | "syncing" // Pushing or pulling.
  | "synced" // Last push/pull succeeded.
  | "offline" // No network or push failed; local still works.
  | "error"; // Auth/RLS/DB rejected the write (surfaced, never hidden).
