import { useCallback, useEffect, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabase } from "./client";
import { useAuth } from "./auth";
import type { JournalEntry, JournalStatus } from "../signals/journal";
import type { MarketCategory } from "../market/classify";

/**
 * Server-side signal history reads (table `signal_history`, written by the
 * headless cron). Authenticated SELECT is granted by migration 0006;
 * anonymous callers stay denied. Rows map onto the local JournalEntry shape
 * so existing cards render them unchanged (outcome/AI fields stay empty —
 * the cron does not fabricate them).
 */

const KNOWN_STATUSES: JournalStatus[] = [
  "NEW",
  "ACTIVE",
  "STRENGTHENING",
  "WEAKENING",
  "INVALIDATED",
  "COMPLETED",
  "EXPIRED",
];

export interface ServerSignalRow {
  id: unknown;
  category: unknown;
  symbol: unknown;
  direction: unknown;
  score: unknown;
  timeframe: unknown;
  entry_low: unknown;
  entry_high: unknown;
  invalidation: unknown;
  tp1: unknown;
  tp2: unknown;
  tp3: unknown;
  risk_reward: unknown;
  setup_type: unknown;
  status: unknown;
  first_seen: unknown;
  last_seen: unknown;
}

function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Map one server row; null when the row cannot honestly be displayed. */
export function mapServerRow(row: ServerSignalRow & { quality?: unknown }): JournalEntry | null {
  if (typeof row.id !== "string" || typeof row.symbol !== "string") return null;
  if (row.direction !== "LONG" && row.direction !== "SHORT") return null;
  if (typeof row.score !== "number" || !Number.isFinite(row.score)) return null;
  if (!KNOWN_STATUSES.includes(row.status as JournalStatus)) return null;
  const firstSeen = Date.parse(String(row.first_seen ?? ""));
  const lastSeen = Date.parse(String(row.last_seen ?? ""));
  if (!Number.isFinite(firstSeen) || !Number.isFinite(lastSeen)) return null;
  return {
    id: row.id,
    symbol: row.symbol,
    firstSeen,
    lastSeen,
    direction: row.direction,
    setupType: (typeof row.setup_type === "string" ? row.setup_type : "TREND") as JournalEntry["setupType"],
    timeframe: typeof row.timeframe === "string" ? row.timeframe : "15m",
    entryLow: numOrNull(row.entry_low),
    entryHigh: numOrNull(row.entry_high),
    invalidation: numOrNull(row.invalidation),
    tp1: numOrNull(row.tp1),
    tp2: numOrNull(row.tp2),
    tp3: numOrNull(row.tp3),
    riskReward: numOrNull(row.risk_reward),
    strength: row.score,
    // Quality is display metadata assessed at write time (migration 0007).
    // Pre-column rows fall back neutrally instead of being hidden.
    quality:
      row.quality === "LOW QUALITY" || row.quality === "HIGH QUALITY" || row.quality === "MEDIUM QUALITY"
        ? row.quality
        : "MEDIUM QUALITY",
    status: row.status as JournalStatus,
    outcome: null,
    aiSummary: null,
    newsHeadlines: [],
    dataTimestamp: lastSeen,
  };
}

export interface ServerHistoryResult {
  entries: JournalEntry[];
  error: string | null;
}

export async function fetchServerHistory(
  client: SupabaseClient,
  opts: { category?: MarketCategory | "ALL"; limit?: number; signal?: AbortSignal },
): Promise<ServerHistoryResult> {
  try {
    let query = client.from("signal_history").select("*");
    if (opts.category && opts.category !== "ALL") {
      query = query.eq("category", opts.category);
    }
    const ordered = query.order("last_seen", { ascending: false }).limit(opts.limit ?? 300);
    const { data, error } = opts.signal ? await ordered.abortSignal(opts.signal) : await ordered;
    if (error) {
      const msg = String((error as { message?: unknown }).message ?? "");
      if (/relation .* does not exist|Could not find the table|404/i.test(msg)) {
        return { entries: [], error: "signal_history migration missing" };
      }
      return { entries: [], error: "Unable to load server signal history." };
    }
    const entries: JournalEntry[] = [];
    for (const row of (data ?? []) as ServerSignalRow[]) {
      const mapped = mapServerRow(row);
      if (mapped) entries.push(mapped);
    }
    return { entries, error: null };
  } catch {
    return { entries: [], error: "Unable to load server signal history." };
  }
}

export interface ServerCounts {
  crypto: number;
  stocks: number;
  commodities: number;
}

/** Last-24h per-category counts (bounded read, counted client-side). */
export async function fetchServerCounts(
  client: SupabaseClient,
): Promise<{ counts: ServerCounts | null; error: string | null }> {
  try {
    const since = new Date(Date.now() - 86_400_000).toISOString();
    const { data, error } = await client
      .from("signal_history")
      .select("category")
      .gte("last_seen", since)
      .limit(1000);
    if (error) return { counts: null, error: "Server counts unavailable." };
    const counts: ServerCounts = { crypto: 0, stocks: 0, commodities: 0 };
    for (const r of ((data ?? []) as Array<{ category?: unknown }>)) {
      if (r.category === "crypto") counts.crypto += 1;
      else if (r.category === "stocks") counts.stocks += 1;
      else if (r.category === "commodities") counts.commodities += 1;
    }
    return { counts, error: null };
  } catch {
    return { counts: null, error: "Server counts unavailable." };
  }
}

export interface ScannerHealth {
  lastRunAt: number | null;
  lastDeliveryAt: number | null;
  perCategory: Record<string, { universe: number; scanned: number; signals: number }>;
  watchdogAlerting: boolean | null;
  /** Outcome-resolver heartbeat (null = never reported). */
  resolver: { at: number; checked: number; resolved: number } | null;
}

/** Cron heartbeat + watchdog arming for the dashboard health panel. */
export async function fetchScannerHealth(
  client: SupabaseClient,
): Promise<{ health: ScannerHealth | null; error: string | null }> {
  try {
    const { data, error } = await client
      .from("scanner_state")
      .select("key,value")
      .in("key", ["cron-monitor", "watchdog", "resolve-outcomes"]);
    if (error) return { health: null, error: "Scanner health unavailable." };
    const rows = ((data ?? []) as Array<{ key?: unknown; value?: unknown }>);
    const byKey = new Map(rows.filter((r) => typeof r.key === "string").map((r) => [r.key as string, r.value]));
    const cron = (byKey.get("cron-monitor") ?? {}) as { lastRun?: unknown };
    const lr = (cron.lastRun ?? {}) as {
      at?: unknown;
      perCategory?: unknown;
      lastDeliveryAt?: unknown;
    };
    const perCategory: ScannerHealth["perCategory"] = {};
    if (lr.perCategory && typeof lr.perCategory === "object") {
      for (const [k, c] of Object.entries(lr.perCategory as Record<string, unknown>)) {
        const cc = (c ?? {}) as Record<string, unknown>;
        perCategory[k] = {
          universe: typeof cc.universe === "number" ? cc.universe : 0,
          scanned: typeof cc.scanned === "number" ? cc.scanned : 0,
          signals: typeof cc.signals === "number" ? cc.signals : 0,
        };
      }
    }
    const wd = byKey.get("watchdog") as { alertedAt?: unknown } | undefined;
    const rs = byKey.get("resolve-outcomes") as { at?: unknown; checked?: unknown; resolved?: unknown } | undefined;
    return {
      health: {
        lastRunAt: typeof lr.at === "number" ? lr.at : null,
        lastDeliveryAt: typeof lr.lastDeliveryAt === "number" ? lr.lastDeliveryAt : null,
        perCategory,
        watchdogAlerting:
          wd && typeof wd === "object" ? (typeof wd.alertedAt === "number" ? true : false) : null,
        resolver:
          rs && typeof rs === "object" && typeof rs.at === "number"
            ? {
                at: rs.at,
                checked: typeof rs.checked === "number" ? rs.checked : 0,
                resolved: typeof rs.resolved === "number" ? rs.resolved : 0,
              }
            : null,
      },
      error: null,
    };
  } catch {
    return { health: null, error: "Scanner health unavailable." };
  }
}

export type HistorySource = "local" | "server";

/** Server history for the current user (login required; anon stays denied). */
export function useServerHistory(
  source: HistorySource,
  category: MarketCategory | "ALL",
  active: boolean,
) {
  const { user } = useAuth();
  const [entries, setEntries] = useState<JournalEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (source !== "server" || !active) return;
    const sb = getSupabase();
    if (!sb || !user) {
      setEntries([]);
      setError("Sign in to view cloud signal history.");
      setLoading(false);
      return;
    }
    let cancelled = false;
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    void fetchServerHistory(sb, { category, limit: 300, signal: ctrl.signal }).then((res) => {
      if (cancelled) return;
      setEntries(res.entries);
      setError(res.error);
      setLoading(false);
    });
    return () => {
      cancelled = true;
      ctrl.abort();
    };
  }, [source, category, active, user, nonce]);

  return { entries, loading, error, refresh };
}

/** Compact 24h server counts for the dashboard (silent when signed out). */
export function useServerCounts(active: boolean) {
  const { user } = useAuth();
  const [counts, setCounts] = useState<ServerCounts | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!active) return;
    const sb = getSupabase();
    if (!sb || !user) {
      setCounts(null);
      setError(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void fetchServerCounts(sb).then((res) => {
      if (cancelled) return;
      setCounts(res.counts);
      setError(res.error);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [active, user]);

  return { counts, loading, error };
}

/** Cron heartbeat for the dashboard health panel (silent when signed out). */
export function useScannerHealth(active: boolean) {
  const { user } = useAuth();
  const [health, setHealth] = useState<ScannerHealth | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!active) return;
    const sb = getSupabase();
    if (!sb || !user) {
      setHealth(null);
      setError(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void fetchScannerHealth(sb).then((res) => {
      if (cancelled) return;
      setHealth(res.health);
      setError(res.error);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [active, user, nonce]);

  return { health, loading, error, refresh };
}
