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
    invalidation: 95,
    tp1: 105,
    tp2: 110,
    tp3: 115,
    risk_reward: 2,
    outcome: null,
    outcome_at: null,
    exit_price: null,
    realized_r: null,
    decided_by: null,
    activation_price: null,
    activation_at: null,
    ambiguous: null,
    setup_type: "TREND",
    quality: "MEDIUM QUALITY",
    entry_type: "MARKET",
    last_seen: "2026-09-30T18:00:00.000Z",
    resolved_at: null,
    reasons: [],
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

  it("preserves every stored field verbatim for the details view", () => {
    const e = mapResolvedRow(
      row({
        outcome: "WIN",
        entry_type: "RETEST",
        activation_price: 100.5,
        activation_at: "2026-09-30T17:30:00.000Z",
        resolved_at: "2026-09-30T20:00:00.000Z",
        reasons: ["r1", 42, null],
      }),
    );
    expect(e?.entryLow).toBe(100);
    expect(e?.entryHigh).toBe(101);
    expect(e?.invalidation).toBe(95);
    expect(e?.tp1).toBe(105);
    expect(e?.tp2).toBe(110);
    expect(e?.tp3).toBe(115);
    expect(e?.riskReward).toBe(2);
    expect(e?.entryType).toBe("RETEST");
    expect(e?.setupType).toBe("TREND");
    expect(e?.quality).toBe("MEDIUM QUALITY");
    expect(e?.lastSeen).toBe(Date.parse("2026-09-30T18:00:00.000Z"));
    expect(e?.resolvedAt).toBe(Date.parse("2026-09-30T20:00:00.000Z"));
    expect(e?.activationPrice).toBe(100.5);
    expect(e?.activationTs).toBe(Date.parse("2026-09-30T17:30:00.000Z"));
    // Reasons keep strings only — never invented, never coerced.
    expect(e?.reasons).toEqual(["r1"]);
    // Bogus entry types fall back to null (legacy display), never guessed.
    expect(mapResolvedRow(row({ entry_type: "MARKETPLACE" }))?.entryType).toBeNull();
  });

  it("never mutates the source row", () => {
    const source = row({ outcome: "WIN", realized_r: 2 });
    const before = JSON.stringify(source);
    mapResolvedRow(source);
    expect(JSON.stringify(source)).toBe(before);
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
