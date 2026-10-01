import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  fetchScannerHealth,
  fetchServerCounts,
  fetchServerHistory,
  mapServerRow,
} from "../history";

function fakeClient(rows: unknown[] | { error: { message: string } }) {
  const query: Record<string, (...args: never[]) => unknown> = {};
  const self = () => query;
  query.select = self;
  query.eq = self;
  query.gte = self;
  query.in = self;
  query.order = self;
  query.limit = self;
  query.abortSignal = self;
  (query as Record<string, unknown>).then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(
      rows !== null && typeof rows === "object" && !Array.isArray(rows) && "error" in rows
        ? rows
        : { data: rows, error: null },
    ).then(resolve);
  return {
    auth: { getSession: async () => ({ data: { session: { user: { id: "u" } } } }) },
    from: () => query,
  } as unknown as SupabaseClient;
}

function row(over: Record<string, unknown> = {}) {
  return {
    id: "BTC|LONG|15m|TREND|1",
    category: "crypto",
    symbol: "BTC",
    direction: "LONG",
    score: 84,
    timeframe: "15m",
    entry_low: 100,
    entry_high: 101,
    invalidation: 95,
    tp1: 110,
    tp2: 115,
    tp3: 120,
    risk_reward: 2,
    setup_type: "TREND",
    quality: "HIGH QUALITY",
    status: "NEW",
    first_seen: "2026-09-30T17:00:00.000Z",
    last_seen: "2026-09-30T18:00:00.000Z",
    ...over,
  };
}

describe("mapServerRow", () => {
  it("maps a valid row onto the journal shape", () => {
    const e = mapServerRow(row());
    expect(e?.symbol).toBe("BTC");
    expect(e?.strength).toBe(84);
    expect(e?.quality).toBe("HIGH QUALITY");
    expect(e?.outcome).toBeNull();
  });

  it("rejects rows that cannot honestly display", () => {
    expect(mapServerRow(row({ direction: "SIDEWAYS" }))).toBeNull();
    expect(mapServerRow(row({ status: "BOGUS" }))).toBeNull();
    expect(mapServerRow(row({ score: Number.NaN }))).toBeNull();
    expect(mapServerRow(row({ id: 42 }))).toBeNull();
  });
});

describe("fetchServerHistory", () => {
  it("returns mapped entries, never throws", async () => {
    const res = await fetchServerHistory(fakeClient([row(), row({ id: "bad", direction: "X" })]), {});
    expect(res.error).toBeNull();
    expect(res.entries).toHaveLength(1);
  });

  it("names a missing migration explicitly", async () => {
    const res = await fetchServerHistory(
      fakeClient({ error: { message: 'relation "public.signal_history" does not exist' } }),
      {},
    );
    expect(res.error).toBe("signal_history migration missing");
    expect(res.entries).toEqual([]);
  });

  it("returns a friendly error on generic failures", async () => {
    const res = await fetchServerHistory(fakeClient({ error: { message: "boom" } }), {});
    expect(res.error).toBe("Unable to load server signal history.");
  });
});

describe("fetchServerCounts", () => {
  it("aggregates 24h rows per category", async () => {
    const res = await fetchServerCounts(
      fakeClient([{ category: "crypto" }, { category: "stocks" }, { category: "stocks" }, { category: "nope" }]),
    );
    expect(res.error).toBeNull();
    expect(res.counts).toEqual({ crypto: 1, stocks: 2, commodities: 0 });
  });
});

describe("fetchScannerHealth", () => {
  it("parses heartbeat + watchdog rows defensively", async () => {
    const client = {
      from: () => ({
        select: () => ({
          in: () => ({
            then: (resolve: (v: unknown) => unknown) =>
              Promise.resolve({
                data: [
                  { key: "cron-monitor", value: { lastRun: { at: 1000, perCategory: { crypto: { universe: 1 } } } } },
                  { key: "watchdog", value: { alertedAt: 2000 } },
                ],
                error: null,
              }).then(resolve),
          }),
        }),
      }),
    } as unknown as SupabaseClient;
    const res = await fetchScannerHealth(client);
    expect(res.error).toBeNull();
    expect(res.health?.lastRunAt).toBe(1000);
    expect(res.health?.perCategory.crypto).toEqual({ universe: 1, scanned: 0, signals: 0 });
    expect(res.health?.watchdogAlerting).toBe(true);
  });

  it("reports missing rows as unknown, never throws", async () => {
    const client = {
      from: () => ({
        select: () => ({
          in: () => ({
            then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve),
          }),
        }),
      }),
    } as unknown as SupabaseClient;
    const res = await fetchScannerHealth(client);
    expect(res.error).toBeNull();
    expect(res.health?.lastRunAt).toBeNull();
    expect(res.health?.watchdogAlerting).toBeNull();
  });
});
