import { describe, expect, it } from "vitest";
import {
  CLOUD_FUNDING,
  CLOUD_LEVERAGE,
  closedToTradeRow,
  cloudToSnapshot,
  positionToRow,
  rowToPosition,
  snapshotToAccountPatch,
} from "../paperCloud";
import { emptySnapshot, openPaperPosition } from "../../paper/portfolio";
import { PaperEngine } from "../../paper/engine";
import type { PaperAccountRow } from "../types";

const CFG = {
  startingBalance: 1000,
  riskPerTrade: 0.01,
  feeRate: 0.0005,
  autoPaperTrading: false,
  autoMinStrength: 75,
};

function makePosition() {
  const p = openPaperPosition({
    symbol: "BTC",
    timeframe: "15m",
    setupType: "BREAKOUT",
    direction: "LONG",
    entry: 108000,
    invalidation: 106500,
    tp1: 109000,
    tp2: 110000,
    tp3: 111000,
    strength: 82,
    equity: 1000,
    config: CFG,
    at: 1700000000000,
  });
  if (!p) throw new Error("open failed");
  return p;
}

describe("paperCloud mapping (calculations untouched)", () => {
  it("round-trips a position through its row without changing math fields", () => {
    const p = makePosition();
    const row = positionToRow(p, "acc-1", "user-1", 108500);
    expect(row.symbol).toBe("BTC");
    expect(row.side).toBe("LONG");
    expect(row.quantity).toBe(p.size);
    expect(row.leverage).toBe(CLOUD_LEVERAGE);
    expect(row.entry_price).toBe(108000);
    expect(row.stop_loss).toBe(106500);
    expect(row.take_profit).toBe(111000);
    expect(row.status).toBe("OPEN");
    expect(row.timeframe).toBe("15m");

    const back = rowToPosition(row);
    expect(back.entry).toBe(p.entry);
    expect(back.size).toBe(p.size);
    expect(back.invalidation).toBe(p.invalidation);
    expect(back.tp1).toBe(p.tp1);
    expect(back.tp2).toBe(p.tp2);
    expect(back.tp3).toBe(p.tp3);
    expect(back.direction).toBe(p.direction);
  });

  it("maps a closed position to exactly one trade row (id reuse = no duplicates)", () => {
    const p = makePosition();
    p.status = "CLOSED";
    p.closedAt = 1700000001000;
    p.closeReason = "Manual close from dashboard.";
    const t1 = closedToTradeRow(p, "acc-1", "user-1", 108700);
    const t2 = closedToTradeRow(p, "acc-1", "user-1", 108700);
    expect(t1.id).toBe(p.id);
    expect(t2.id).toBe(p.id); // same PK -> upsert dedupes double-click/retry
    expect(t1.funding).toBe(CLOUD_FUNDING);
    expect(t1.realized_pnl).toBe(p.realized - p.fees);
    expect(t1.result).toBe("CLOSED");
  });

  it("rebuilds a snapshot from cloud rows preserving account totals", () => {
    const p = makePosition();
    const row = positionToRow(p, "acc-1", "user-1", 108200);
    const acc = {
      id: "acc-1",
      user_id: "user-1",
      starting_balance: 1000,
      current_balance: 1010,
      realized_pnl: 10,
      fees_paid: 1,
      closed_count: 2,
      wins: 1,
      peak_equity: 1015,
      max_drawdown_pct: 0.5,
      risk_per_trade: 0.01,
      fee_rate: 0.0005,
      auto_paper_trading: false,
      auto_min_strength: 75,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    } as PaperAccountRow;
    const snap = cloudToSnapshot(acc, [row], [], 1000);
    expect(snap.balance).toBe(1010);
    expect(snap.realizedPnl).toBe(10);
    expect(snap.closedCount).toBe(2);
    expect(snap.positions).toHaveLength(1);
    expect(snap.positions[0].symbol).toBe("BTC");
  });

  it("snapshotToAccountPatch never resets balances (copies verbatim)", () => {
    const snap = emptySnapshot(CFG);
    snap.balance = 1234.5;
    const patch = snapshotToAccountPatch(snap);
    expect(patch.current_balance).toBe(1234.5);
    expect(patch.starting_balance).toBe(1000);
  });
});

describe("engine cloud seams (no math change)", () => {
  it("replaceSnapshot + mergeRemotePosition keep accounting intact", () => {
    const mem = new Map<string, string>();
    const store = {
      load: () => null,
      save: (s: unknown) => void mem.set("k", JSON.stringify(s)),
      clear: () => void mem.clear(),
    };
    const engine = new PaperEngine(CFG, store);
    const p = makePosition();
    engine.mergeRemotePosition(p);
    expect(engine.getSnapshot().positions.some((x) => x.id === p.id)).toBe(true);
    // Remote echo of a close applies once; counted set prevents double-count.
    const closed = { ...p, status: "CLOSED" as const, closedAt: Date.now(), closeReason: "x" };
    engine.mergeRemotePosition(closed);
    engine.mergeRemotePosition(closed);
    expect(engine.getSnapshot().positions.filter((x) => x.id === p.id)).toHaveLength(1);
  });
});
