import { describe, expect, it } from "vitest";
import {
  openPaperPosition,
  unrealizedFor,
  validatePaperOpen,
  type OpenPaperArgs,
} from "../portfolio";
import { PaperEngine } from "../engine";
import { DEFAULT_MAX_NOTIONAL_TO_EQUITY, maxNotionalOf } from "../types";

const CFG = {
  startingBalance: 1000,
  riskPerTrade: 0.01,
  feeRate: 0,
  autoPaperTrading: false,
  autoMinStrength: 75,
};

function openArgs(over?: Partial<OpenPaperArgs>): OpenPaperArgs {
  return {
    symbol: "OP",
    timeframe: "15m",
    setupType: "BOUNCE",
    direction: "LONG",
    entry: 100,
    invalidation: 95,
    tp1: 105,
    tp2: 110,
    tp3: 115,
    strength: 80,
    equity: 1000,
    config: CFG,
    ...over,
  };
}

const memStore = () => {
  const mem = new Map<string, string>();
  return {
    load: () => {
      const raw = mem.get("k");
      return raw ? (JSON.parse(raw) as never) : null;
    },
    save: (s: unknown) => {
      mem.set("k", JSON.stringify(s));
    },
    clear: () => mem.clear(),
  };
};

describe("validatePaperOpen (P0-2 notional/size safety)", () => {
  it("accepts a normal risk-based open", () => {
    const v = validatePaperOpen(openArgs());
    expect(v.ok).toBe(true);
    expect(v.code).toBeNull();
    // risk $10, stop 5 → size 2, notional 200
    expect(v.size).toBeCloseTo(2, 8);
    expect(v.notional).toBeCloseTo(200, 8);
  });

  it("rejects a stop on the wrong side with a truthful code", () => {
    const v = validatePaperOpen(openArgs({ entry: 90 })); // stop 95 above entry for LONG
    expect(v.ok).toBe(false);
    expect(v.code).toBe("INVALID_STOP_SIDE");
    expect(v.message).toMatch(/wrong side/i);
  });

  it("rejects a stop that is too close to entry", () => {
    const v = validatePaperOpen(openArgs({ entry: 100, invalidation: 99.999 }));
    expect(v.ok).toBe(false);
    expect(v.code).toBe("STOP_TOO_CLOSE");
    expect(v.message).toMatch(/too close/i);
  });

  it("rejects an enormous notional from a tight stop", () => {
    // risk $10, stop 0.1 (0.1% — above the 5bps closeness floor) → size 100, notional 10k = 10x equity
    const v = validatePaperOpen(openArgs({ entry: 100, invalidation: 99.9 }));
    expect(v.ok).toBe(false);
    expect(v.code).toBe("NOTIONAL_EXCEEDS_MAX");
    expect(v.message).toMatch(/maximum allowed notional/i);
  });

  it("rejects invalid prices, risk and balance with distinct messages", () => {
    expect(validatePaperOpen(openArgs({ entry: 0 })).code).toBe("INVALID_PRICE");
    expect(validatePaperOpen(openArgs({ entry: NaN })).code).toBe("INVALID_PRICE");
    expect(validatePaperOpen(openArgs({ equity: 0 })).code).toBe("INSUFFICIENT_BALANCE");
    expect(validatePaperOpen(openArgs({ config: { ...CFG, riskPerTrade: 0 } })).code).toBe("INVALID_RISK");
    expect(validatePaperOpen(openArgs({ config: { ...CFG, riskPerTrade: 2 } })).code).toBe("INVALID_RISK");
  });

  it("honors a configurable maximum instead of a hardcoded number", () => {
    expect(DEFAULT_MAX_NOTIONAL_TO_EQUITY).toBe(5);
    expect(maxNotionalOf(CFG)).toBe(5);
    expect(maxNotionalOf({ ...CFG, maxNotionalToEquity: 2 })).toBe(2);
    // Legacy snapshots without the field fall back to the default.
    expect(maxNotionalOf({ ...CFG, maxNotionalToEquity: undefined })).toBe(5);
    // A tighter cap rejects what the default allows.
    const tight = openArgs({ config: { ...CFG, maxNotionalToEquity: 0.1 } });
    expect(validatePaperOpen(tight).code).toBe("NOTIONAL_EXCEEDS_MAX");
  });

  it("openPaperPosition still returns null (never throws) on invalid input", () => {
    expect(openPaperPosition(openArgs({ entry: 90 }))).toBeNull();
    expect(openPaperPosition(openArgs({ entry: 100, invalidation: 99.9 }))).toBeNull();
  });
});

describe("PaperEngine.tryOpen truthful errors (P0-2)", () => {
  it("distinguishes duplicates from validation failures", () => {
    const engine = new PaperEngine(CFG, memStore());
    const marks = new Map([["OP", 100]]);
    const base = {
      symbol: "OP",
      timeframe: "15m",
      setupType: "BOUNCE",
      direction: "LONG" as const,
      entry: 100,
      invalidation: 95,
      tp1: 105,
      tp2: 110,
      tp3: 115,
      strength: 80,
    };
    const first = engine.tryOpen(base, marks);
    expect(first.position).not.toBeNull();
    expect(first.error).toBeNull();
    // Second open on the same symbol reports the duplicate — truthfully.
    const dup = engine.tryOpen(base, marks);
    expect(dup.position).toBeNull();
    expect(dup.error).toMatch(/already have an open/i);
    // A sizing failure on a DIFFERENT symbol never claims "already open".
    const bad = engine.tryOpen({ ...base, symbol: "ETH", entry: 100, invalidation: 99.9 }, marks);
    expect(bad.position).toBeNull();
    expect(bad.error).toMatch(/maximum allowed notional/i);
    expect(bad.error).not.toMatch(/already have an open/i);
  });
});

describe("close estimate math (P0-1 confirmation content)", () => {
  it("estimates realized-on-close as realized - fees + unrealized", () => {
    const engine = new PaperEngine(CFG, memStore());
    const marks = new Map([["OP", 100]]);
    const opened = engine.open(
      {
        symbol: "OP",
        timeframe: "15m",
        setupType: "BOUNCE",
        direction: "LONG",
        entry: 100,
        invalidation: 95,
        tp1: 105,
        tp2: 110,
        tp3: 115,
        strength: 80,
      },
      marks,
    );
    expect(opened).not.toBeNull();
    if (!opened) return;
    const p = engine.getSnapshot().positions[0];
    const unreal = unrealizedFor(p, 108);
    const estimate = p.realized - p.fees + unreal;
    expect(unreal).toBeGreaterThan(0);
    expect(estimate).toBeCloseTo(unreal - p.fees, 8);
  });
});
