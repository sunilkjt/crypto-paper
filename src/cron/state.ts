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

export interface CronState {
  seens: Record<string, Record<string, SeenEntry>>;
  cooldowns: Record<string, number>;
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
  return {
    async load(): Promise<CronState> {
      const res = await run(
        `${base}/rest/v1/scanner_state?key=eq.${STATE_KEY}&select=value`,
        { headers },
      );
      if (!res.ok) {
        throw new Error(`State load failed (HTTP ${res.status}).`);
      }
      const rows = (await res.json()) as Array<{ value?: unknown }>;
      const value = Array.isArray(rows) && rows.length > 0 ? rows[0].value : null;
      if (!isCronState(value)) return { seens: {}, cooldowns: {} };
      return value;
    },
    async save(state: CronState): Promise<void> {
      const res = await run(`${base}/rest/v1/scanner_state`, {
        method: "POST",
        headers: { ...headers, Prefer: "resolution=merge-duplicates" },
        body: JSON.stringify({ key: STATE_KEY, value: state }),
      });
      if (!res.ok) {
        throw new Error(`State save failed (HTTP ${res.status}).`);
      }
    },
  };
}
