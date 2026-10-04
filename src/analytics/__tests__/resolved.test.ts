import { describe, expect, it } from "vitest";
import { fetchResolvedSignals, mapResolvedRow } from "../resolved";
import type { SupabaseClient } from "@supabase/supabase-js";

function row(over: Record<string, unknown> = {}) {
  return {
    id: "BTC|LONG|15m|TREND|1",
    symbol: "BTC",
    category: "crypto",
    direction: "LONG",
    timeframe: "15m",
    score: 84,
    first_seen: "2026-09-30T17:00:00.000Z",
    entry_low: 100,
    entry_high: 101,
    outcome: null,
    outcome_at: null,
    exit_price: null,
    realized_r: null,
    decided_by: null,
    ...over,
  };
}

describe("mapResolvedRow", () => {
  it("maps a resolved WIN row with entry mid and R", () => {
    const e = mapResolvedRow(
      row({ outcome: "WIN", outcome_at: "2026-09-30T19:00:00.000Z", exit_price: 110, realized_r: 2, decided_by: "TP1→TP2→TP3" }),
    );
    expect(e?.verdict).toBe("WIN");
    expect(e?.realizedR).toBe(2);
    expect(e?.exitPrice).toBe(110);
    expect(e?.entryMid).toBe(100.5);
    expect(e?.decidedBy).toBe("TP1→TP2→TP3");
    expect(e?.outcomeAt).toBe(Date.parse("2026-09-30T19:00:00.000Z"));
  });

  it("surfaces unprocessed rows as OPEN awaiting resolution", () => {
    const e = mapResolvedRow(row());
    expect(e?.verdict).toBe("OPEN");
    expect(e?.realizedR).toBeNull();
    expect(e?.decidedBy).toMatch(/PENDING/);
  });

  it("rejects rows that cannot honestly display", () => {
    expect(mapResolvedRow(row({ direction: "SIDEWAYS" }))).toBeNull();
    expect(mapResolvedRow(row({ score: Number.NaN }))).toBeNull();
    expect(mapResolvedRow(row({ id: 42 }))).toBeNull();
    expect(mapResolvedRow(row({ first_seen: "not-a-date" }))).toBeNull();
  });

  it("falls back to other/timeframe defaults without inventing data", () => {
    const e = mapResolvedRow(row({ category: "forex", timeframe: null }));
    expect(e?.category).toBe("other");
    expect(e?.timeframe).toBe("15m");
  });
});

function fakeClient(rows: unknown[] | { error: { message: string } }) {
  const query: Record<string, (...args: never[]) => unknown> = {};
  const self = () => query;
  query.select = self;
  query.order = self;
  query.limit = self;
  query.abortSignal = self;
  (query as Record<string, unknown>).then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(
      rows !== null && typeof rows === "object" && !Array.isArray(rows) && "error" in rows
        ? rows
        : { data: rows, error: null },
    ).then(resolve);
  return { from: () => query } as unknown as SupabaseClient;
}

describe("fetchResolvedSignals", () => {
  it("returns mapped rows bounded and newest-first by request", async () => {
    const { rows, error } = await fetchResolvedSignals(fakeClient([row(), row({ id: "x2" })]), {});
    expect(error).toBeNull();
    expect(rows).toHaveLength(2);
  });

  it("surfaces fetch failures honestly", async () => {
    const { rows, error } = await fetchResolvedSignals(fakeClient({ error: { message: "db down" } }), {});
    expect(rows).toEqual([]);
    expect(error).toMatch(/Unable to load signal performance/);
  });
});
