/**
 * Headless cron state, persisted in Supabase (table `scanner_state`, key
 * `cron-monitor`). Holds per-category monitor snapshots (signal lifecycle
 * continuity across scheduled runs) and the delivery cooldown map (exactly-
 * once notification per fact). Service-role REST only — never frontend.
 */

export interface SeenEntry {
  strength: number;
  status: string;
  firstSeen: number;
}

export interface CategoryHeartbeat {
  universe: number;
  scanned: number;
  signals: number;
}

export interface LastRun {
  at: number;
  perCategory: Record<string, CategoryHeartbeat>;
  delivered: number;
  lastDeliveryAt: number | null;
}

export interface CronState {
  seens: Record<string, Record<string, SeenEntry>>;
  cooldowns: Record<string, number>;
  /** Heartbeat for /status (optional for backward compatibility). */
  lastRun?: LastRun;
}

export const EMPTY_STATE: CronState = { seens: {}, cooldowns: {} };

const STATE_KEY = "cron-monitor";

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

function isCronState(v: unknown): v is CronState {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.seens === "object" &&
    o.seens !== null &&
    typeof o.cooldowns === "object" &&
    o.cooldowns !== null
  );
}

export interface StateStore {
  load: () => Promise<CronState>;
  save: (state: CronState) => Promise<void>;
  /** Raw keyed access for auxiliary rows (e.g. watchdog) — never touches cron-monitor. */
  loadValue: (key: string) => Promise<unknown>;
  saveValue: (key: string, value: unknown) => Promise<void>;
}

export function createSupabaseStateStore(opts: {
  url: string;
  serviceKey: string;
  fetchFn?: FetchFn;
}): StateStore {
  const base = opts.url.replace(/\/$/, "");
  const headers = {
    apikey: opts.serviceKey,
    Authorization: `Bearer ${opts.serviceKey}`,
    "Content-Type": "application/json",
  };
  const run = opts.fetchFn ?? fetch;
  async function loadValue(key: string): Promise<unknown> {
    const res = await run(
      `${base}/rest/v1/scanner_state?key=eq.${encodeURIComponent(key)}&select=value`,
      { headers },
    );
    if (res.status === 404) {
      throw new Error("State load failed: scanner_state table missing (run migration 0003).");
    }
    if (!res.ok) {
      throw new Error(`State load failed (HTTP ${res.status}).`);
    }
    const rows = (await res.json()) as Array<{ value?: unknown }>;
    return Array.isArray(rows) && rows.length > 0 ? rows[0].value : null;
  }
  async function saveValue(key: string, value: unknown): Promise<void> {
    const res = await run(`${base}/rest/v1/scanner_state`, {
      method: "POST",
      headers: { ...headers, Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify({ key, value }),
    });
    if (res.status === 404) {
      throw new Error("State save failed: scanner_state table missing (run migration 0003).");
    }
    if (!res.ok) {
      throw new Error(`State save failed (HTTP ${res.status}).`);
    }
  }
  return {
    async load(): Promise<CronState> {
      const value = await loadValue(STATE_KEY);
      if (!isCronState(value)) return { seens: {}, cooldowns: {} };
      return value;
    },
    async save(state: CronState): Promise<void> {
      await saveValue(STATE_KEY, state);
    },
    loadValue,
    saveValue,
  };
}
