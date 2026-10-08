import { describe, expect, it } from "vitest";
import type { Candle } from "../../market/hyperliquid/types";
import { alreadyResolved, decideRowAction, planOf, type UnresolvedRowLike } from "../resolve";

const T0 = 1_700_000_000_000;
const H = 3_600_000;
const LIFETIME = 24 * H;

function candle(ts: number, high: number, low: number): Candle {
  return { timestamp: ts, open: (high + low) / 2, high, low, close: (high + low) / 2, volume: 100 };
}

function row(over: Partial<UnresolvedRowLike> = {}): UnresolvedRowLike {
  return {
    id: "r1",
    symbol: "BTC",
    direction: "LONG",
    timeframe: "15m",
    entry_low: 100,
    entry_high: 101,
    invalidation: 95,
    tp1: 105,
    tp2: 110,
    tp3: 115,
    first_seen: new Date(T0).toISOString(),
    outcome: null,
    entry_type: null,
    ...over,
  };
}

const plan = () => planOf(row())!;

describe("alreadyResolved", () => {
  it("treats every terminal verdict as resolved, null/OPEN as not", () => {
    for (const v of ["WIN", "LOSS", "BREAKEVEN", "EXPIRED", "UNKNOWN"]) {
      expect(alreadyResolved(v)).toBe(true);
    }
    expect(alreadyResolved(null)).toBe(false);
    expect(alreadyResolved("OPEN")).toBe(false);
    expect(alreadyResolved(undefined)).toBe(false);
  });
});

describe("planOf", () => {  it("accepts a complete LONG/SHORT plan with entry mid + risk", () => {
    const p = planOf(row());
    expect(p?.entryMid).toBe(100.5);
    expect(p?.risk).toBe(5.5);
    const s = planOf(row({ direction: "SHORT", entry_low: 100, entry_high: 101, invalidation: 106 }));
    expect(s?.risk).toBe(5.5);
  });

  it("rejects unmeasurable plans (bad ts, missing levels, wrong-side stop)", () => {
    expect(planOf(row({ first_seen: "garbage" }))).toBeNull();
    expect(planOf(row({ tp1: null }))).toBeNull();
    expect(planOf(row({ entry_low: null }))).toBeNull();
    expect(planOf(row({ invalidation: 105 }))).toBeNull(); // LONG stop above entry
    expect(planOf(row({ direction: "SHORT", invalidation: 95 }))).toBeNull();
  });
});

describe("decideRowAction", () => {
  it("resolves LONG TP cascade and LONG stop-out", () => {
    const win = decideRowAction(
      plan(),
      [candle(T0 + H, 106, 101), candle(T0 + 2 * H, 111, 106), candle(T0 + 3 * H, 116, 111)],
      T0 + 4 * H,
      LIFETIME,
    );
    expect(win.action).toBe("resolve");
    if (win.action === "resolve") {
      expect(win.patch.outcome).toBe("WIN");
      // Entry mid 100.5, risk 5.5: (0.818 + 1.727 + 2.636)/3 ≈ 1.73.
      expect(win.patch.realized_r).toBeCloseTo(1.73, 2);
    }
    const loss = decideRowAction(plan(), [candle(T0 + H, 101, 94)], T0 + 2 * H, LIFETIME);
    expect(loss.action).toBe("resolve");
    if (loss.action === "resolve") expect(loss.patch.outcome).toBe("LOSS");
  });

  it("resolves SHORT TP and SHORT SL", () => {
    const p = planOf(row({ direction: "SHORT", invalidation: 106, tp1: 95, tp2: 90, tp3: 85 }))!;
    const win = decideRowAction(p, [candle(T0 + H, 99, 94), candle(T0 + 2 * H, 94, 89), candle(T0 + 3 * H, 89, 84)], T0 + 4 * H, LIFETIME);
    expect(win.action).toBe("resolve");
    if (win.action === "resolve") expect(win.patch.outcome).toBe("WIN");
    const loss = decideRowAction(p, [candle(T0 + H, 107, 100)], T0 + 2 * H, LIFETIME);
    expect(loss.action).toBe("resolve");
    if (loss.action === "resolve") expect(loss.patch.outcome).toBe("LOSS");
  });

  it("blends multiple TP levels (TP1 then stop is not a full WIN)", () => {
    const d = decideRowAction(plan(), [candle(T0 + H, 106, 101), candle(T0 + 2 * H, 101, 94)], T0 + 3 * H, LIFETIME);
    expect(d.action).toBe("resolve");
    if (d.action === "resolve") {
      expect(d.patch.outcome).toBe("LOSS");
      expect(d.patch.decided_by).toBe("TP1→STOP");
    }
  });

  it("leaves genuinely unresolved signals as skip (OPEN)", () => {
    const d = decideRowAction(plan(), [candle(T0 + H, 101, 99)], T0 + 2 * H, LIFETIME);
    expect(d).toEqual({ action: "skip" });
  });

  it("enforces the signal-timestamp boundary both ways", () => {
    // Candle exactly AT the signal timestamp is stale (excluded) → skip.
    const atTs = decideRowAction(plan(), [candle(T0, 200, 199)], T0 + H, LIFETIME);
    expect(atTs).toEqual({ action: "skip" });
    // Candle exactly AT the horizon is included.
    const atHorizon = decideRowAction(
      plan(),
      [candle(T0 + LIFETIME, 94, 93)],
      T0 + LIFETIME + H,
      LIFETIME,
    );
    expect(atHorizon.action).toBe("resolve");
    if (atHorizon.action === "resolve") expect(atHorizon.patch.outcome).toBe("LOSS");
  });

  it("treats stale pre-signal candles as missing data (skip, never guessed)", () => {
    const stale = [candle(T0 - 3 * H, 200, 199), candle(T0 - H, 50, 49)];
    // Within lifetime → skip (transient, retry later).
    expect(decideRowAction(plan(), stale, T0 + H, LIFETIME)).toEqual({ action: "skip" });
    // Beyond lifetime → still skip: replay-level UNKNOWN conflates "no
    // follow data" (possibly transient) and only a failed fetch with an
    // expired horizon resolves UNKNOWN (delisted/unservable markets).
    expect(decideRowAction(plan(), stale, T0 + LIFETIME + H, LIFETIME)).toEqual({ action: "skip" });
    expect(decideRowAction(plan(), [], T0 + LIFETIME + H, LIFETIME).action).toBe("resolve");
  });

  it("is idempotent: same inputs always yield the identical patch", () => {
    const candles = [candle(T0 + H, 106, 101), candle(T0 + 2 * H, 111, 106), candle(T0 + 3 * H, 116, 111)];
    const a = decideRowAction(plan(), candles, T0 + 4 * H, LIFETIME);
    const b = decideRowAction(plan(), candles, T0 + 4 * H, LIFETIME);
    expect(a).toEqual(b);
    expect(a.action).toBe("resolve");
  });

  it("never mutates candles", () => {
    const candles = [candle(T0 + H, 106, 101)];
    const before = JSON.stringify(candles);
    decideRowAction(plan(), candles, T0 + 2 * H, LIFETIME);
    expect(JSON.stringify(candles)).toBe(before);
  });
});

describe("entry-type gating (RETEST vs MARKET vs legacy)", () => {
  const zoneRow = { entry_low: 98, entry_high: 100 };

  it("parses engine entry types, legacy rows measure immediately", () => {
    expect(planOf(row({ ...zoneRow, entry_type: "RETEST" }))?.entryType).toBe("RETEST");
    expect(planOf(row({ ...zoneRow, entry_type: "MARKET" }))?.entryType).toBe("MARKET");
    expect(planOf(row({ ...zoneRow, entry_type: null }))?.entryType).toBeNull();
  });

  it("RETEST requires a zone touch (NO_FILL when price runs away)", () => {
    const p = planOf(row({ ...zoneRow, entry_type: "RETEST" }))!;
    const runaway = [candle(T0 + H, 104, 103), ...Array.from({ length: 30 }, (_, i) => candle(T0 + (2 + i) * H, 110, 108))];
    const d = decideRowAction(p, runaway, T0 + 40 * H, LIFETIME);
    expect(d.action).toBe("resolve");
    if (d.action === "resolve") {
      expect(d.patch.outcome).toBe("NO_FILL");
      expect(d.patch.realized_r).toBeNull();
      expect(d.patch.activation_price).toBeNull();
    }
  });

  it("RETEST activates on touch and reports activation fields", () => {
    const p = planOf(row({ ...zoneRow, entry_type: "RETEST" }))!;
    const d = decideRowAction(
      p,
      [candle(T0 + H, 99, 97), candle(T0 + 2 * H, 106, 104), candle(T0 + 3 * H, 111, 109), candle(T0 + 4 * H, 116, 114)],
      T0 + 5 * H,
      LIFETIME,
    );
    expect(d.action).toBe("resolve");
    if (d.action === "resolve") {
      expect(d.patch.outcome).toBe("WIN");
      expect(d.patch.activation_price).toBe(99);
      expect(d.patch.activation_at).toBe(new Date(T0 + H).toISOString());
      expect(d.patch.ambiguous).toBe(false);
    }
  });

  it("RETEST stop-before-touch is INVALIDATED (never a loss)", () => {
    const p = planOf(row({ ...zoneRow, entry_type: "RETEST" }))!;
    const d = decideRowAction(p, [candle(T0 + H, 103, 102), candle(T0 + 2 * H, 102, 94)], T0 + 3 * H, LIFETIME);
    expect(d.action).toBe("resolve");
    if (d.action === "resolve") expect(d.patch.outcome).toBe("INVALIDATED");
  });

  it("MARKET activates immediately with identical numbers to legacy", () => {
    const candles = [candle(T0 + H, 106, 101), candle(T0 + 2 * H, 111, 106), candle(T0 + 3 * H, 116, 111)];
    const m = decideRowAction(planOf(row({ ...zoneRow, entry_type: "MARKET" }))!, candles, T0 + 4 * H, LIFETIME);
    const l = decideRowAction(planOf(row({ ...zoneRow, entry_type: null }))!, candles, T0 + 4 * H, LIFETIME);
    expect(m).toEqual(l);
    if (m.action === "resolve") expect(m.patch.outcome).toBe("WIN");
  });

  it("forwards finer candles so same-bar conflicts can resolve", () => {
    const p = planOf(row({ entry_type: "MARKET" }))!;
    const coarse = [candle(T0 + H, 106, 94), candle(T0 + 2 * H, 112, 108), candle(T0 + 3 * H, 117, 113)];
    const first = decideRowAction(p, coarse, T0 + 4 * H, LIFETIME);
    expect(first.action).toBe("resolve");
    if (first.action !== "resolve" || !first.ambiguousBar) {
      throw new Error("expected an ambiguous bar for the second pass");
    }
    expect(first.patch.ambiguous).toBe(true);
    // Finer 5m bars inside the first 15m bar: TP1 prints before the stop.
    const finer = [candle(T0, 102, 101), candle(T0 + 300_000, 107, 106)];
    const second = decideRowAction(p, coarse, T0 + 4 * H, LIFETIME, finer);
    expect(second.action).toBe("resolve");
    if (second.action === "resolve") {
      expect(second.patch.ambiguous).toBe(false);
      expect(second.patch.outcome).toBe("WIN");
      expect(second.patch.decided_by).toBe("TP1→TP2→TP3");
    }
  });
});
