import { describe, expect, it } from "vitest";
import {
  applyPaperTick,
  closePaperPosition,
  emptySnapshot,
  openPaperPosition,
  realizedR,
  unrealizedFor,
  type OpenPaperArgs,
} from "../portfolio";
import { PaperEngine, LocalStoragePaperStore } from "../engine";

const CFG = { startingBalance: 1000, riskPerTrade: 0.01, feeRate: 0, autoPaperTrading: false, autoMinStrength: 75 };

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

describe("paper lifecycle", () => {
  it("sizes from equity risk and progresses OPEN → TP hits → close", () => {
    const p = openPaperPosition(openArgs());
    expect(p).not.toBeNull();
    // risk $10, stop 5 → size 2, notional 200
    expect(p?.size).toBeCloseTo(2, 8);
    expect(p?.status).toBe("OPEN");
    if (!p) return;
    expect(applyPaperTick(p, 103, 0)).toBe(false);
    expect(p.status).toBe("OPEN");
    expect(applyPaperTick(p, 106, 0)).toBe(false);
    expect(p.status).toBe("TP1 HIT");
    expect(unrealizedFor(p, 108)).toBeCloseTo((108 - 100) * (4 / 3), 6);
    expect(applyPaperTick(p, 111, 0)).toBe(false);
    expect(p.status).toBe("TP2 HIT");
    expect(applyPaperTick(p, 116, 0)).toBe(true);
    expect(p.status).toBe("TP3 HIT");
    expect(p.closedAt).not.toBeNull();
    expect(realizedR(p)).toBeGreaterThan(0);
  });

  it("stops through invalidation and closes manually", () => {
    const p = openPaperPosition(openArgs());
    expect(p).not.toBeNull();
    if (!p) return;
    expect(applyPaperTick(p, 94, 0)).toBe(true);
    expect(p.status).toBe("STOPPED");
    expect(realizedR(p)).toBeLessThan(0);

    const q = openPaperPosition(openArgs());
    if (!q) return;
    closePaperPosition(q, 102, 0, "Manual.");
    expect(q.status).toBe("CLOSED");
    expect(q.closeReason).toBe("Manual.");
  });

  it("rejects invalid opens and ignores bad ticks", () => {
    expect(openPaperPosition(openArgs({ entry: 90 }))).toBeNull(); // stop above entry for LONG
    expect(openPaperPosition(openArgs({ equity: 0 }))).toBeNull();
    const p = openPaperPosition(openArgs());
    if (!p) return;
    expect(applyPaperTick(p, NaN, 0)).toBe(false);
    expect(p.status).toBe("OPEN");
  });
});

describe("paper engine", () => {
  it("accounts balance across ticks and persists without secrets", () => {
    const mem = new Map<string, string>();
    const store = new LocalStoragePaperStore();
    void store;
    const fake = {
      load: () => {
        const raw = mem.get("k");
        return raw ? (JSON.parse(raw) as never) : null;
      },
      save: (s: unknown) => {
        mem.set("k", JSON.stringify(s));
      },
      clear: () => mem.clear(),
    };
    const engine = new PaperEngine(CFG, fake);
    expect(engine.getSnapshot().balance).toBe(1000);
    const pos = engine.open(
      { symbol: "OP", timeframe: "15m", setupType: "BOUNCE", direction: "LONG", entry: 100, invalidation: 95, tp1: 105, tp2: 110, tp3: 115, strength: 80 },
      new Map([["OP", 100]]),
    );
    expect(pos).not.toBeNull();
    // No pyramiding the same coin.
    expect(
      engine.open(
        { symbol: "OP", timeframe: "15m", setupType: "TREND", direction: "LONG", entry: 100, invalidation: 95, tp1: 105, tp2: 110, tp3: 115, strength: 70 },
        new Map([["OP", 100]]),
      ),
    ).toBeNull();
    engine.tick("OP", 120); // blows through all TPs
    const after = engine.getSnapshot();
    expect(after.closedCount).toBe(1);
    expect(after.balance).toBeGreaterThan(1000);
    expect(after.wins).toBe(1);
    // Second tick must not double-count.
    engine.tick("OP", 120);
    expect(engine.getSnapshot().closedCount).toBe(1);
    // Persisted snapshot holds no credentials of any kind.
    const saved = mem.get("k") as string;
    expect(saved).not.toMatch(/key|secret|password|seed|token/i);
    expect(emptySnapshot(CFG).balance).toBe(1000);
  });
});
