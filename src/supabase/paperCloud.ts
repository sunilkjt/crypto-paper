import type { SupabaseClient } from "@supabase/supabase-js";
import { unrealizedFor, type PaperPosition, type PaperSnapshot } from "../paper";
import type { PaperAccountRow, PaperPositionRow, PaperTradeRow } from "./types";

/**
 * Paper <-> Supabase row mapping + CRUD. Pure mapping is unit-tested.
 * The local engine owns ALL math (entry/SL/TP, sizing, R, fees); this layer
 * only persists snapshots. Leverage is always 1 locally (margin == notional)
 * and funding is always 0 locally — stored explicitly for schema parity.
 */

export const CLOUD_LEVERAGE = 1;
export const CLOUD_FUNDING = 0;

const toMs = (iso: string | null): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};
const toIso = (ms: number | null): string | null =>
  ms === null || ms === undefined || !Number.isFinite(ms) ? null : new Date(ms).toISOString();

// --- Snapshot <-> account ---------------------------------------------------

export function snapshotToAccountPatch(snap: PaperSnapshot): {
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
} {
  return {
    starting_balance: snap.config.startingBalance,
    current_balance: snap.balance,
    realized_pnl: snap.realizedPnl,
    fees_paid: snap.feesPaid,
    closed_count: snap.closedCount,
    wins: snap.wins,
    peak_equity: snap.peakEquity,
    max_drawdown_pct: snap.maxDrawdownPct,
    risk_per_trade: snap.config.riskPerTrade,
    fee_rate: snap.config.feeRate,
    auto_paper_trading: snap.config.autoPaperTrading,
    auto_min_strength: snap.config.autoMinStrength,
  };
}

// --- Position <-> row -------------------------------------------------------

export function positionToRow(
  p: PaperPosition,
  accountId: string,
  userId: string,
  markPrice: number | null,
): PaperPositionRow {
  const unreal = markPrice === null ? 0 : unrealizedFor(p, markPrice);
  return {
    id: p.id,
    account_id: accountId,
    user_id: userId,
    symbol: p.symbol,
    side: p.direction,
    quantity: p.size,
    leverage: CLOUD_LEVERAGE,
    entry_price: p.entry,
    current_price: markPrice,
    stop_loss: p.invalidation,
    take_profit: p.tp3,
    unrealized_pnl: Number.isFinite(unreal) ? unreal : 0,
    status: p.status,
    opened_at: toIso(p.openedAt) ?? new Date().toISOString(),
    updated_at: new Date().toISOString(),
    timeframe: p.timeframe,
    setup_type: p.setupType,
    tp1: p.tp1,
    tp2: p.tp2,
    tp3: p.tp3,
    invalidation: p.invalidation,
    strength: p.strength,
    thirds_remaining: p.thirdsRemaining,
    realized: p.realized,
    fees: p.fees,
    notional: p.notional,
    margin: p.margin,
    risk: p.risk,
    close_reason: p.closeReason,
    closed_at: toIso(p.closedAt),
  };
}

export function rowToPosition(r: PaperPositionRow): PaperPosition {
  return {
    id: r.id,
    symbol: r.symbol,
    timeframe: r.timeframe ?? "15m",
    setupType: r.setup_type ?? "CLOUD",
    direction: r.side,
    entry: r.entry_price,
    size: r.quantity,
    notional: r.notional ?? r.quantity * r.entry_price,
    margin: r.margin ?? r.quantity * r.entry_price,
    risk: r.risk ?? 0,
    invalidation: r.invalidation ?? r.stop_loss ?? r.entry_price,
    tp1: r.tp1 ?? r.take_profit ?? r.entry_price,
    tp2: r.tp2 ?? r.take_profit ?? r.entry_price,
    tp3: r.tp3 ?? r.take_profit ?? r.entry_price,
    strength: r.strength ?? 0,
    status: (r.status as PaperPosition["status"]) ?? "OPEN",
    thirdsRemaining: r.thirds_remaining ?? 3,
    realized: r.realized ?? 0,
    fees: r.fees ?? 0,
    openedAt: toMs(r.opened_at) ?? Date.now(),
    closedAt: toMs(r.closed_at),
    closeReason: r.close_reason,
  };
}

// --- Closed position -> trade row -------------------------------------------

export function closedToTradeRow(
  p: PaperPosition,
  accountId: string,
  userId: string,
  exitPrice: number | null,
): Omit<PaperTradeRow, "created_at"> {
  return {
    id: p.id, // PK reuse => a close inserts exactly one history row.
    account_id: accountId,
    user_id: userId,
    symbol: p.symbol,
    side: p.direction,
    quantity: p.size,
    leverage: CLOUD_LEVERAGE,
    entry_price: p.entry,
    exit_price: exitPrice,
    stop_loss: p.invalidation,
    take_profit: p.tp3,
    fees: p.fees,
    funding: CLOUD_FUNDING,
    realized_pnl: p.realized - p.fees,
    result: p.status,
    signal_id: null, // Engine has no signal ids; stays null (nullable).
    opened_at: toIso(p.openedAt) ?? new Date().toISOString(),
    closed_at: toIso(p.closedAt),
    timeframe: p.timeframe,
    setup_type: p.setupType,
    tp1: p.tp1,
    tp2: p.tp2,
    tp3: p.tp3,
    strength: p.strength,
    close_reason: p.closeReason,
  };
}

// --- CRUD -------------------------------------------------------------------

/** One account per user. Never resets an existing balance; races resolve via UNIQUE(user_id). */
export async function ensurePaperAccount(
  sb: SupabaseClient,
  startingBalance: number,
): Promise<{ account: PaperAccountRow | null; error: string | null }> {
  const { data: userData } = await sb.auth.getUser();
  const user = userData.user;
  if (!user) return { account: null, error: "Not signed in." };

  const { data: existing, error: selErr } = await sb
    .from("paper_accounts")
    .select("*")
    .eq("user_id", user.id)
    .maybeSingle();
  if (selErr) return { account: null, error: selErr.message };
  if (existing) return { account: existing as PaperAccountRow, error: null };

  const safeStart = Number.isFinite(startingBalance) && startingBalance > 0 ? startingBalance : 1000;
  const { data: inserted, error: insErr } = await sb
    .from("paper_accounts")
    .insert({
      user_id: user.id,
      starting_balance: safeStart,
      current_balance: safeStart,
      peak_equity: safeStart,
    })
    .select("*")
    .maybeSingle();
  if (!insErr && inserted) return { account: inserted as PaperAccountRow, error: null };

  // Race: another tab/device created it first (UNIQUE violation) -> re-read.
  if (insErr && (insErr.code === "23505" || /duplicate|unique/i.test(insErr.message))) {
    const { data: retry, error: retryErr } = await sb
      .from("paper_accounts")
      .select("*")
      .eq("user_id", user.id)
      .maybeSingle();
    if (!retryErr && retry) return { account: retry as PaperAccountRow, error: null };
  }
  return { account: null, error: insErr?.message ?? "Could not create paper account." };
}

export async function fetchPositions(
  sb: SupabaseClient,
  accountId: string,
): Promise<{ rows: PaperPositionRow[]; error: string | null }> {
  const { data, error } = await sb
    .from("paper_positions")
    .select("*")
    .eq("account_id", accountId)
    .order("opened_at", { ascending: false })
    .limit(500);
  if (error) return { rows: [], error: error.message };
  return { rows: (data ?? []) as PaperPositionRow[], error: null };
}

export async function fetchTrades(
  sb: SupabaseClient,
  accountId: string,
): Promise<{ rows: PaperTradeRow[]; error: string | null }> {
  const { data, error } = await sb
    .from("paper_trades")
    .select("*")
    .eq("account_id", accountId)
    .order("closed_at", { ascending: false })
    .limit(500);
  if (error) return { rows: [], error: error.message };
  return { rows: (data ?? []) as PaperTradeRow[], error: null };
}

/** Idempotent upserts (onConflict id). Safe on double-click / retry / refresh. */
export async function upsertAccount(
  sb: SupabaseClient,
  accountId: string,
  snap: PaperSnapshot,
): Promise<string | null> {
  const { error } = await sb
    .from("paper_accounts")
    .update(snapshotToAccountPatch(snap))
    .eq("id", accountId);
  return error ? error.message : null;
}

export async function upsertPositionRow(
  sb: SupabaseClient,
  row: PaperPositionRow,
): Promise<string | null> {
  const { error } = await sb.from("paper_positions").upsert(row, { onConflict: "id" });
  return error ? error.message : null;
}

export async function upsertTradeRow(
  sb: SupabaseClient,
  row: Omit<PaperTradeRow, "created_at">,
): Promise<string | null> {
  const { error } = await sb.from("paper_trades").upsert(row, { onConflict: "id" });
  return error ? error.message : null;
}

export async function recordEquitySnapshot(
  sb: SupabaseClient,
  accountId: string,
  userId: string,
  equity: number,
  balance: number,
  unrealized: number,
): Promise<void> {
  try {
    await sb.from("paper_equity_snapshots").insert({
      account_id: accountId,
      user_id: userId,
      equity,
      balance,
      unrealized_pnl: unrealized,
    });
  } catch {
    // Best-effort curve only; never blocks trading.
  }
}

/**
 * Initial-load policy (pure, unit-tested). Cloud is authoritative:
 * whenever the cloud holds ANY account data (positions or trades), the local
 * snapshot — including a default $1,000 singleton or stale localStorage —
 * must be replaced, never pushed back. Returns null when the cloud is empty
 * (caller then offers migration or starts fresh locally).
 */
export function decideInitialLoad(
  local: PaperSnapshot,
  account: PaperAccountRow,
  positionRows: PaperPositionRow[],
  tradeRows: Omit<PaperTradeRow, "created_at">[],
): { replace: true; snapshot: PaperSnapshot } | { replace: false; snapshot: null } {
  void local;
  if (positionRows.length > 0 || tradeRows.length > 0) {
    return { replace: true, snapshot: cloudToSnapshot(account, positionRows, tradeRows, 0) };
  }
  return { replace: false, snapshot: null };
}

/** Rebuild a local PaperSnapshot from cloud rows (math untouched, values copied). */
export function cloudToSnapshot(
  account: PaperAccountRow,
  positionRows: PaperPositionRow[],
  tradeRows: Omit<PaperTradeRow, "created_at">[],
  localStartingBalance: number,
): PaperSnapshot {
  const positions: PaperPosition[] = [];
  const seen = new Set<string>();
  // Open positions table holds opens AND recently-closed (until mirrored to trades).
  for (const r of positionRows) {
    const p = rowToPosition(r);
    positions.push(p);
    seen.add(p.id);
  }
  // Trades table is the durable history; add any closed trade missing from positions.
  for (const t of tradeRows) {
    if (seen.has(t.id)) continue;
    positions.push({
      id: t.id,
      symbol: t.symbol,
      timeframe: t.timeframe ?? "15m",
      setupType: t.setup_type ?? "CLOUD",
      direction: t.side,
      entry: t.entry_price,
      size: t.quantity,
      notional: t.quantity * t.entry_price,
      margin: t.quantity * t.entry_price,
      risk: 0,
      invalidation: t.stop_loss ?? t.entry_price,
      tp1: t.tp1 ?? t.take_profit ?? t.entry_price,
      tp2: t.tp2 ?? t.take_profit ?? t.entry_price,
      tp3: t.tp3 ?? t.take_profit ?? t.entry_price,
      strength: t.strength ?? 0,
      status: ((t.result as PaperPosition["status"]) ?? "CLOSED"),
      thirdsRemaining: 0,
      realized: t.realized_pnl + t.fees,
      fees: t.fees,
      openedAt: toMs(t.opened_at) ?? Date.now(),
      closedAt: toMs(t.closed_at),
      closeReason: t.close_reason,
    });
  }
  positions.sort((a, b) => b.openedAt - a.openedAt);
  void localStartingBalance;
  return {
    config: {
      startingBalance: account.starting_balance,
      riskPerTrade: account.risk_per_trade,
      feeRate: account.fee_rate,
      autoPaperTrading: account.auto_paper_trading,
      autoMinStrength: account.auto_min_strength,
    },
    balance: account.current_balance,
    realizedPnl: account.realized_pnl,
    feesPaid: account.fees_paid,
    positions,
    closedCount: account.closed_count,
    wins: account.wins,
    peakEquity: account.peak_equity,
    maxDrawdownPct: account.max_drawdown_pct,
    updatedAt: Date.now(),
  };
}
