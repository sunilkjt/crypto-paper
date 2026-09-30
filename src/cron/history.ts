import type { MarketCategory } from "../market/classify";

/**
 * Server-side signal history writer (table `signal_history`). The headless
 * cron upserts every qualifying signal (non-WAIT, at/above the notify
 * strength bar) so Telegram pull commands read one indexed table — never
 * scans, never AI. Delivery failures never block history writes.
 */

export interface HistoryRow {
  id: string;
  category: MarketCategory;
  symbol: string;
  direction: "LONG" | "SHORT";
  score: number;
  timeframe: string;
  entry_low: number | null;
  entry_high: number | null;
  invalidation: number | null;
  tp1: number | null;
  tp2: number | null;
  tp3: number | null;
  risk_reward: number | null;
  setup_type: string | null;
  status: string;
  first_seen: string;
  last_seen: string;
}

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export interface HistoryStore {
  upsert: (rows: HistoryRow[]) => Promise<void>;
  pruneOlderThanDays: (days: number) => Promise<void>;
}

export function createHistoryStore(opts: {
  url: string;
  serviceKey: string;
  fetchFn?: FetchFn;
}): HistoryStore {
  const base = opts.url.replace(/\/$/, "");
  const headers = {
    apikey: opts.serviceKey,
    Authorization: `Bearer ${opts.serviceKey}`,
    "Content-Type": "application/json",
  };
  const run = opts.fetchFn ?? fetch;
  return {
    async upsert(rows: HistoryRow[]): Promise<void> {
      if (rows.length === 0) return;
      const res = await run(`${base}/rest/v1/signal_history`, {
        method: "POST",
        headers: { ...headers, Prefer: "resolution=merge-duplicates" },
        body: JSON.stringify(rows),
      });
      if (!res.ok) {
        throw new Error(`History upsert failed (HTTP ${res.status}).`);
      }
    },
    async pruneOlderThanDays(days: number): Promise<void> {
      const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
      const res = await run(
        `${base}/rest/v1/signal_history?last_seen=lt.${encodeURIComponent(cutoff)}`,
        { method: "DELETE", headers },
      );
      if (!res.ok) {
        throw new Error(`History prune failed (HTTP ${res.status}).`);
      }
    },
  };
}
