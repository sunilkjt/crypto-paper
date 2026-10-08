import { describe, expect, it } from "vitest";
import type { Candle } from "../../market/hyperliquid/types";
import {
  applyPerformanceFilters,
  computePerformanceStats,
  orderBarTouches,
  replayThirds,
  scoreBand,
  zoneIntersects,
  type ReplayInput,
  type ResolvedSignal,
} from "../performance";

const T0 = 1_700_000_000_000;
const H = 3_600_000;

function candle(ts: number, high: number, low: number): Candle {
  return { timestamp: ts, open: (high + low) / 2, high, low, close: (high + low) / 2, volume: 100 };
}

// LONG: entry 100, risk 5 (SL 95), TP1 105 (1R), TP2 110 (2R), TP3 115 (3R).
function longInput(candles: Candle[], over?: Partial<ReplayInput>): ReplayInput {
  return {
    direction: "LONG",
    entryMid: 100,
    risk: 5,
    invalidation: 95,
    tp1: 105,
    tp2: 110,
    tp3: 115,
    entryLow: null,
    entryHigh: null,
    followCandles: candles,
    signalTs: T0,
    maxLifetimeMs: 24 * H,
    ...over,
  };
}

describe("replayThirds outcomes", () => {
  it("LONG TP1→TP2→TP3 is a WIN at +2R", () => {
    const r = replayThirds(
      longInput([candle(T0 + H, 106, 101), candle(T0 + 2 * H, 111, 106), candle(T0 + 3 * H, 116, 111)]),
    );
    expect(r.verdict).toBe("WIN");
    expect(r.realizedR).toBeCloseTo(2, 8); // (1+2+3)/3
    expect(r.exitPrice).toBe(115);
    expect(r.decidedBy).toBe("TP1→TP2→TP3");
    expect(r.outcomeAt).toBe(T0 + 3 * H);
  });

  it("LONG straight to stop is a LOSS at -1R", () => {
    const r = replayThirds(longInput([candle(T0 + H, 101, 94)]));
    expect(r.verdict).toBe("LOSS");
    expect(r.realizedR).toBeCloseTo(-1, 8);
    expect(r.exitPrice).toBe(95);
    expect(r.decidedBy).toBe("STOP");
  });

  it("SHORT TP cascade wins, SHORT stop-out loses", () => {
    const base = longInput([], { direction: "SHORT", entryMid: 100, risk: 5, invalidation: 105, tp1: 95, tp2: 90, tp3: 85 });
    const win = replayThirds({ ...base, followCandles: [candle(T0 + H, 99, 94), candle(T0 + 2 * H, 94, 89), candle(T0 + 3 * H, 89, 84)] });
    expect(win.verdict).toBe("WIN");
    expect(win.realizedR).toBeCloseTo(2, 8);
    const loss = replayThirds({ ...base, followCandles: [candle(T0 + H, 106, 100)] });
    expect(loss.verdict).toBe("LOSS");
    expect(loss.realizedR).toBeCloseTo(-1, 8);
  });

  it("processes the stop before targets on the same bar (conservative, flagged)", () => {
    // Bar touches BOTH TP1 (high 106) and the stop (low 94): stop wins,
    // flagged ambiguous (order unknowable from OHLC alone).
    const r = replayThirds(longInput([candle(T0 + H, 106, 94)]));
    expect(r.verdict).toBe("LOSS");
    expect(r.decidedBy).toBe("STOP* (ambiguous bar)");
    expect(r.ambiguous).toBe(true);
    expect(r.ambiguousBar).toMatchObject({ target: 105, targetName: "TP1" });
  });

  it("TP1 then stop blends to a small loss (no invented WIN)", () => {
    const r = replayThirds(longInput([candle(T0 + H, 106, 101), candle(T0 + 2 * H, 101, 94)]));
    // +1R on one third, -1R on two thirds → -1/3R (rounded to 2dp).
    expect(r.realizedR).toBeCloseTo(-0.33, 2);
    expect(r.verdict).toBe("LOSS");
    expect(r.decidedBy).toBe("TP1→STOP");
  });

  it("flat price inside the horizon expires without a verdict", () => {
    const candles = Array.from({ length: 24 }, (_, i) => candle(T0 + (i + 1) * H, 101, 99));
    const r = replayThirds(longInput(candles));
    expect(r.verdict).toBe("EXPIRED");
    expect(r.realizedR).toBeNull();
    expect(r.outcomeAt).toBe(T0 + 24 * H);
  });

  it("truncated data before the horizon reads OPEN (never guessed)", () => {
    const r = replayThirds(longInput([candle(T0 + H, 101, 99)]));
    expect(r.verdict).toBe("OPEN");
    expect(r.realizedR).toBeNull();
    expect(r.outcomeAt).toBeNull();
  });

  it("invalid plans and missing candles read UNKNOWN", () => {
    expect(replayThirds(longInput([], { risk: 0 })).verdict).toBe("UNKNOWN");
    expect(replayThirds(longInput([], { entryMid: NaN })).verdict).toBe("UNKNOWN");
    expect(replayThirds(longInput([], { invalidation: 105 })).verdict).toBe("UNKNOWN"); // wrong-side stop
    expect(replayThirds(longInput([])).verdict).toBe("UNKNOWN");
  });

  it("breakeven tolerance bands tiny R around zero", () => {
    // TP1 at 0.05R above entry, then stopped: (0.05 - 1 - 1)/3 ≈ -0.65 → LOSS.
    // A pure graze: TP levels equal entry → 0R → BREAKEVEN.
    const r = replayThirds(
      longInput([candle(T0 + H, 100.1, 99.9), candle(T0 + 2 * H, 100.1, 99.9), candle(T0 + 3 * H, 100.1, 99.9)], {
        tp1: 100,
        tp2: 100,
        tp3: 100,
      }),
    );
    expect(r.realizedR).toBeCloseTo(0, 8);
    expect(r.verdict).toBe("BREAKEVEN");
  });

  it("ignores candles past the lifetime (no look-ahead)", () => {
    const r = replayThirds(
      longInput([candle(T0 + 25 * H, 200, 199)], { maxLifetimeMs: 24 * H }),
    );
    // Candle beyond horizon is excluded → no observable action → UNKNOWN.
    expect(r.verdict).toBe("UNKNOWN");
  });
});

function resolved(over: Partial<ResolvedSignal> & { id: string }): ResolvedSignal {
  return {
    symbol: "BTC",
    category: "crypto",
    direction: "LONG",
    timeframe: "15m",
    score: 80,
    firstSeen: T0,
    entryMid: 100,
    verdict: "WIN",
    realizedR: 1,
    exitPrice: 105,
    outcomeAt: T0 + H,
    decidedBy: "TP1→TP2→TP3",
    activationPrice: 100,
    activationTs: T0,
    ambiguous: false,
    ...over,
  };
}

describe("computePerformanceStats", () => {
  const rows = [
    resolved({ id: "w1", verdict: "WIN", realizedR: 2, outcomeAt: T0 + H }),
    resolved({ id: "w2", verdict: "WIN", realizedR: 1, outcomeAt: T0 + 2 * H, direction: "SHORT", symbol: "ETH" }),
    resolved({ id: "l1", verdict: "LOSS", realizedR: -1, outcomeAt: T0 + 3 * H }),
    resolved({ id: "b1", verdict: "BREAKEVEN", realizedR: 0, outcomeAt: T0 + 4 * H, category: "stocks", symbol: "xyz:NVDA", score: 92 }),
    resolved({ id: "o1", verdict: "OPEN", realizedR: null, outcomeAt: null }),
    resolved({ id: "e1", verdict: "EXPIRED", realizedR: null, outcomeAt: T0 + 24 * H }),
  ];

  it("counts verdicts and rates completed signals only", () => {
    const s = computePerformanceStats(rows);
    expect(s.total).toBe(6);
    expect(s.wins).toBe(2);
    expect(s.losses).toBe(1);
    expect(s.breakeven).toBe(1);
    expect(s.open).toBe(1);
    expect(s.expired).toBe(1);
    expect(s.completed).toBe(4);
    expect(s.winRate).toBe(50);
    expect(s.avgR).toBe(0.5); // (2+1-1+0)/4
    expect(s.expectancy).toBe(0.5);
    expect(s.profitFactor).toBe(3); // 3 / 1
  });

  it("builds a running cumulative R curve in outcome order", () => {
    const s = computePerformanceStats(rows);
    expect(s.cumulativeR.map((p) => p.cumulativeR)).toEqual([2, 3, 2, 2]);
    expect(s.cumulativeR.map((p) => p.n)).toEqual([1, 2, 3, 4]);
  });

  it("groups by category, direction, score and symbol with sample sizes", () => {
    const s = computePerformanceStats(rows);
    expect(s.byCategory.map((g) => g.key)).toEqual(["crypto", "stocks"]);
    expect(s.byDirection.map((g) => [g.key, g.signals])).toEqual([["LONG", 3], ["SHORT", 1]]);
    expect(s.byScore.find((g) => g.key === "90–100")?.signals).toBe(1);
    expect(s.bySymbol[0].key).toBe("BTC"); // highest cumulative R first
    for (const g of [...s.byCategory, ...s.byDirection, ...s.byScore, ...s.bySymbol]) {
      expect(g.signals).toBeGreaterThanOrEqual(0);
    }
  });

  it("never mutates its inputs", () => {
    const before = JSON.stringify(rows);
    computePerformanceStats(rows);
    applyPerformanceFilters(rows, { category: "ALL", direction: "ALL", minScore: 0, range: "all" });
    expect(JSON.stringify(rows)).toBe(before);
  });
});

describe("scoreBand + filters", () => {  it("bands scores per spec", () => {
    expect(scoreBand(95)).toBe("90–100");
    expect(scoreBand(85)).toBe("80–89");
    expect(scoreBand(75)).toBe("70–79");
    expect(scoreBand(65)).toBe("60–69");
    expect(scoreBand(40)).toBe("<60");
  });

  it("filters category, direction, score and date range", () => {
    const rows = [
      resolved({ id: "a", category: "crypto", direction: "LONG", score: 85, firstSeen: T0 }),
      resolved({ id: "b", category: "stocks", direction: "SHORT", score: 65, firstSeen: T0 - 40 * 86_400_000 }),
    ];
    const base = { category: "ALL" as const, direction: "ALL" as const, minScore: 0, range: "all" as const };
    expect(applyPerformanceFilters(rows, base)).toHaveLength(2);
    expect(applyPerformanceFilters(rows, { ...base, category: "stocks" }).map((r) => r.id)).toEqual(["b"]);
    expect(applyPerformanceFilters(rows, { ...base, direction: "SHORT" }).map((r) => r.id)).toEqual(["b"]);
    expect(applyPerformanceFilters(rows, { ...base, minScore: 80 }).map((r) => r.id)).toEqual(["a"]);
    expect(
      applyPerformanceFilters(rows, { ...base, range: "30d" }, T0 + H).map((r) => r.id),
    ).toEqual(["a"]);
  });
});

describe("activation gating (RETEST vs MARKET)", () => {
  // Zone 98–100, price action around it. RETEST requires a touch first.
  const zone = { entryLow: 98, entryHigh: 100, immediate: false };

  it("activates on zone touch, then measures TP/SL from there", () => {
    const r = replayThirds(
      longInput([candle(T0 + H, 101, 99), candle(T0 + 2 * H, 106, 104), candle(T0 + 3 * H, 111, 109), candle(T0 + 4 * H, 116, 114)], zone),
    );
    expect(r.activated).toBe(true);
    expect(r.activationTs).toBe(T0 + H);
    expect(r.verdict).toBe("WIN");
  });

  it("never activates when price runs without touching the zone (NOT A TRADE)", () => {
    // 103 → 110 straight up, zone 98–100 untouched (default 24h lifetime).
    const candles = [candle(T0 + H, 104, 103), candle(T0 + 2 * H, 108, 106), candle(T0 + 3 * H, 111, 109)];
    const open = replayThirds(longInput(candles, zone));
    expect(open.verdict).toBe("OPEN");
    expect(open.activated).toBe(false);
    const nofill = replayThirds(longInput([...candles, ...Array.from({ length: 30 }, (_, i) => candle(T0 + (4 + i) * H, 112, 110))], zone));
    expect(nofill.verdict).toBe("NO_FILL");
    expect(nofill.realizedR).toBeNull();
  });

  it("marks INVALIDATED when the stop prints before any zone touch (never a loss)", () => {
    const r = replayThirds(longInput([candle(T0 + H, 103, 102), candle(T0 + 2 * H, 102, 94)], zone));
    expect(r.verdict).toBe("INVALIDATED");
    expect(r.activated).toBe(false);
    expect(r.realizedR).toBeNull();
  });

  it("pre-activation zone+stop same bar is INVALIDATED and flagged", () => {
    // Bar range 93–99 overlaps zone 98–100 AND touches SL 95.
    const r = replayThirds(longInput([candle(T0 + H, 99, 93)], zone));
    expect(r.verdict).toBe("INVALIDATED");
    expect(r.ambiguous).toBe(true);
  });

  it("MARKET signals activate at the signal bar (identical numbers to legacy)", () => {
    const legacy = replayThirds(longInput([candle(T0 + H, 106, 101), candle(T0 + 2 * H, 111, 106), candle(T0 + 3 * H, 116, 111)]));
    const market = replayThirds(
      longInput([candle(T0 + H, 106, 101), candle(T0 + 2 * H, 111, 106), candle(T0 + 3 * H, 116, 111)], { entryLow: 98, entryHigh: 100, immediate: true }),
    );
    expect(market.activated).toBe(true);
    expect(market.activationTs).toBe(T0);
    expect(market.realizedR).toBe(legacy.realizedR);
    expect(market.verdict).toBe(legacy.verdict);
  });
});

describe("ambiguity detection and finer-TF resolution", () => {
  it("detects zone overlap both directions", () => {
    expect(zoneIntersects(99, 101, 98, 100)).toBe(true); // LONG pullback
    expect(zoneIntersects(103, 104, 98, 100)).toBe(false); // above, untouched
    expect(zoneIntersects(96, 97, 98, 100)).toBe(false); // below, untouched
  });

  it("orders touches from finer candles (TP-first resolves cleanly)", () => {
    const m5 = (ts: number, high: number, low: number) => candle(ts, high, low);
    const barOpen = T0;
    const finer = [m5(T0, 102, 101), m5(T0 + 300_000, 107, 106), m5(T0 + 600_000, 96, 94)];
    // TP touched in the second 5m bar, stop only in the third → TARGET first.
    expect(orderBarTouches({ finer, isLong: true, stop: 95, target: 105, barOpen, barClose: T0 + 900_000 })).toBe("TARGET");
    // Stop first ordering.
    const finer2 = [m5(T0, 102, 101), m5(T0 + 300_000, 96, 94)];
    expect(orderBarTouches({ finer: finer2, isLong: true, stop: 95, target: 105, barOpen, barClose: T0 + 900_000 })).toBe("STOP");
    // Same finer bar touches both → still ambiguous.
    const finer3 = [m5(T0, 107, 94)];
    expect(orderBarTouches({ finer: finer3, isLong: true, stop: 95, target: 105, barOpen, barClose: T0 + 900_000 })).toBeNull();
    // Out-of-span finer bars are ignored.
    const finer4 = [m5(T0 + 900_000, 107, 106)];
    expect(orderBarTouches({ finer: finer4, isLong: true, stop: 95, target: 105, barOpen, barClose: T0 + 900_000 })).toBeNull();
  });

  it("replay consumes finer evidence to clear ambiguity", () => {
    const coarse = [candle(T0 + H, 106, 94)]; // touches TP1 105 and SL 95
    const plain = replayThirds(longInput(coarse));
    expect(plain.ambiguous).toBe(true);
    const finer = [candle(T0, 102, 101), candle(T0 + 300_000, 107, 106), candle(T0 + 600_000, 96, 94)];
    const resolved = replayThirds(longInput(coarse, { finer }));
    expect(resolved.ambiguous).toBe(false);
    expect(resolved.decidedBy).toBe("TP1");
    expect(resolved.verdict).toBe("OPEN"); // TP1 exited, thirds remain, data ends
  });
});
