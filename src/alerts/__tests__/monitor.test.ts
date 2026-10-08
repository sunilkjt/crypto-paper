import { describe, expect, it } from "vitest";
import { evaluateScan, evaluateTargets } from "../monitor";
import type { ScannedCoin } from "../../scanner/engine";
import type { Signal } from "../../analysis/signal";
import { DEFAULT_ALERT_SETTINGS } from "../settings";

function signal(over: Partial<Signal> = {}): Signal {
  return {
    symbol: "OP",
    timestamp: 2000,
    timeframe: "15m",
    direction: "LONG",
    signalStrength: 80,
    classification: "STRONG SETUP",
    entryLow: 1.4,
    entryHigh: 1.45,
    entryType: "MARKET",
    entryStatus: "READY",
    invalidation: 1.32,
    tp1: 1.55,
    tp2: 1.65,
    tp3: 1.8,
    riskReward: 2.5,
    trend: "BULLISH",
    momentum: "POSITIVE",
    rsi: 58,
    volume: "HIGH",
    marketStructure: "BULLISH",
    brokeAbove: false,
    brokeBelow: false,
    retestHeld: false,
    riskAtr: 1.2,
    atrPct: 1,
    falseBreakout: false,
    multiTimeframe: null,
    components: { trend: 20, momentum: 14, volume: 12, structure: 14, mtf: 12 },
    bounce: { direction: "LONG", bounceScore: 80, bounceReasons: [], bounceWarnings: [], components: { support: 25, momentum: 30, volume: 15, structure: 0, mtf: 10 } },
    reasons: [],
    warnings: [],
    dataTimestamp: 1000,
    longScore: 80,
    shortScore: 30,
    ...over,
  };
}

function scanned(symbol: string, sig: Signal, setupType: "BOUNCE" | "TREND" = "BOUNCE"): ScannedCoin {
  return {
    symbol,
    signal: { ...sig, symbol },
    setupType,
    quality: "HIGH QUALITY",
    id: `${symbol}|${sig.direction}|15m|${setupType}|1000`,
  };
}

const CTX = {
  marks: new Map<string, number | null>([["OP", 1.44]]),
  watchlist: [] as string[],
  settings: { ...DEFAULT_ALERT_SETTINGS },
  now: 5000,
};

describe("evaluateScan", () => {
  it("detects new signals (bounce variant for bounce setups)", () => {
    const events = evaluateScan(new Map(), [scanned("OP", signal())], new Map(), CTX);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("BOUNCE_DETECTED");
    expect(events[0].previousStrength).toBeNull();
    expect(events[0].status).toBe("NEW");
  });

  it("never re-emits unchanged signals (duplicate protection)", () => {
    const r = scanned("OP", signal());
    const prev = new Map([[r.id as string, { strength: 80, status: "ACTIVE" }]]);
    expect(evaluateScan(prev, [r], new Map([[r.id as string, "ACTIVE"]]), CTX)).toEqual([]);
  });

  it("emits strengthen/weaken on lifecycle moves and invalidation", () => {
    const r = scanned("OP", signal());
    const id = r.id as string;
    const up = evaluateScan(
      new Map([[id, { strength: 70, status: "ACTIVE" }]]),
      [r],
      new Map([[id, "STRENGTHENING"]]),
      CTX,
    );
    expect(up.map((e) => e.type)).toEqual(["SIGNAL_STRENGTHENED"]);
    expect(up[0].previousStrength).toBe(70);
    const down = evaluateScan(
      new Map([[id, { strength: 85, status: "ACTIVE" }]]),
      [{ ...r, signal: { ...r.signal, signalStrength: 70 } }],
      new Map([[id, "WEAKENING"]]),
      CTX,
    );
    expect(down.map((e) => e.type)).toEqual(["SIGNAL_WEAKENED"]);
    const dead = evaluateScan(
      new Map([[id, { strength: 80, status: "ACTIVE" }]]),
      [r],
      new Map([[id, "INVALIDATED"]]),
      CTX,
    );
    expect(dead.map((e) => e.type)).toEqual(["SIGNAL_INVALIDATED"]);
    expect(dead[0].detail).toBe("invalidation");
  });

  it("respects alert filters (strength, direction, watchlist)", () => {
    const r = scanned("OP", signal());
    expect(evaluateScan(new Map(), [r], new Map(), { ...CTX, settings: { ...CTX.settings, minStrength: 90 } })).toEqual([]);
    expect(
      evaluateScan(new Map(), [r], new Map(), { ...CTX, settings: { ...CTX.settings, directions: ["SHORT"] } }).length,
    ).toBe(0);
    expect(
      evaluateScan(new Map(), [r], new Map(), { ...CTX, settings: { ...CTX.settings, watchlistOnly: true } }).length,
    ).toBe(0);
    expect(
      evaluateScan(new Map(), [r], new Map(), { ...CTX, watchlist: ["OP"], settings: { ...CTX.settings, watchlistOnly: true } }).length,
    ).toBe(1);
  });

  it("skips WAIT signals entirely", () => {
    const r = scanned("OP", signal({ direction: "WAIT", signalStrength: 10 }));
    expect(evaluateScan(new Map(), [{ ...r, id: null }], new Map(), CTX)).toEqual([]);
  });
});

describe("evaluateTargets", () => {
  it("fires TP/ENTRY touches with per-level stable IDs", () => {
    const r = scanned("OP", signal());
    const events = evaluateTargets([r], new Map([["OP", 1.6]]), CTX);
    const types = events.map((e) => `${e.type}:${e.detail}`);
    expect(types).toContain("TARGET_REACHED:TP1");
    expect(types).not.toContain("TARGET_REACHED:TP2");
    expect(events[0].id).toContain("TP1");
  });

  it("fires invalidation touches and ignores unknown marks", () => {
    const r = scanned("OP", signal());
    const dead = evaluateTargets([r], new Map([["OP", 1.3]]), CTX);
    expect(dead.map((e) => e.type)).toContain("SIGNAL_INVALIDATED");
    expect(evaluateTargets([r], new Map(), CTX)).toEqual([]);
    expect(evaluateTargets([r], new Map([["OP", NaN]]), CTX)).toEqual([]);
  });
});
