import type { SupabaseClient } from "@supabase/supabase-js";
import type { MarketCategory } from "../market/classify";
import type { ResolvedSignal, SignalVerdict } from "./performance";

const VERDICTS: SignalVerdict[] = ["WIN", "LOSS", "BREAKEVEN", "EXPIRED", "OPEN", "UNKNOWN", "NO_FILL", "INVALIDATED"];

interface ResolvedRow {
  id: unknown;
  symbol: unknown;
  category: unknown;
  direction: unknown;
  timeframe: unknown;
  score: unknown;
  first_seen: unknown;
  entry_low: unknown;
  entry_high: unknown;
  outcome: unknown;
  outcome_at: unknown;
  exit_price: unknown;
  realized_r: unknown;
  decided_by: unknown;
  activation_price: unknown;
  activation_at: unknown;
  ambiguous: unknown;
}

function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function msOrNull(v: unknown): number | null {
  const t = Date.parse(String(v ?? ""));
  return Number.isFinite(t) ? t : null;
}

/**
 * Map one signal_history row onto the analytics shape. Rows the resolver
 * has not processed yet (outcome NULL — including pre-migration rows)
 * surface as OPEN / awaiting resolution, never as completed results.
 * Returns null only when the row cannot honestly be displayed at all.
 */
export function mapResolvedRow(row: ResolvedRow): ResolvedSignal | null {
  if (typeof row.id !== "string" || typeof row.symbol !== "string") return null;
  if (row.direction !== "LONG" && row.direction !== "SHORT") return null;
  if (typeof row.score !== "number" || !Number.isFinite(row.score)) return null;
  const firstSeen = msOrNull(row.first_seen);
  if (firstSeen === null) return null;
  const cat: MarketCategory | "other" =
    row.category === "crypto" || row.category === "stocks" || row.category === "commodities"
      ? row.category
      : "other";
  const verdict: SignalVerdict = VERDICTS.includes(row.outcome as SignalVerdict)
    ? (row.outcome as SignalVerdict)
    : "OPEN";
  const pending = !VERDICTS.includes(row.outcome as SignalVerdict);
  const entryMid =
    typeof row.entry_low === "number" && typeof row.entry_high === "number"
      ? (row.entry_low + row.entry_high) / 2
      : numOrNull(row.entry_low);
  return {
    id: row.id,
    symbol: row.symbol,
    category: cat,
    direction: row.direction,
    timeframe: typeof row.timeframe === "string" ? row.timeframe : "15m",
    score: row.score,
    firstSeen,
    entryMid,
    verdict,
    realizedR: verdict === "WIN" || verdict === "LOSS" || verdict === "BREAKEVEN" ? numOrNull(row.realized_r) ?? 0 : null,
    exitPrice: numOrNull(row.exit_price),
    outcomeAt: msOrNull(row.outcome_at),
    decidedBy: pending ? "PENDING — awaiting resolution" : typeof row.decided_by === "string" ? row.decided_by : "",
    activationPrice: numOrNull(row.activation_price),
    activationTs: msOrNull(row.activation_at),
    ambiguous: row.ambiguous === true,
  };
}

export interface ResolvedFetch {
  rows: ResolvedSignal[];
  error: string | null;
}

/**
 * Server-authoritative analytics read (signal_history, service of the
 * resolver job). Authenticated callers only — anonymous stays denied by
 * RLS absence, same as the history module. Bounded read, newest first.
 */
export async function fetchResolvedSignals(
  client: SupabaseClient,
  opts: { limit?: number; signal?: AbortSignal },
): Promise<ResolvedFetch> {
  try {
    const query = client
      .from("signal_history")
      .select("*")
      .order("first_seen", { ascending: false })
      .limit(opts.limit ?? 1000);
    const { data, error } = opts.signal ? await query.abortSignal(opts.signal) : await query;
    if (error) return { rows: [], error: "Unable to load signal performance data." };
    const rows: ResolvedSignal[] = [];
    for (const row of (data ?? []) as ResolvedRow[]) {
      const mapped = mapResolvedRow(row);
      if (mapped) rows.push(mapped);
    }
    return { rows, error: null };
  } catch {
    return { rows: [], error: "Unable to load signal performance data." };
  }
}
