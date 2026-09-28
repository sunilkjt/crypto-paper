import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  closedToTradeRow,
  decideInitialLoad,
  ensurePaperAccount,
  positionToRow,
  snapshotToAccountPatch,
} from "../paperCloud";
import type { PaperAccountRow } from "../types";
import { emptySnapshot, openPaperPosition } from "../../paper/portfolio";
import { PaperEngine } from "../../paper/engine";

const CFG100 = {
  startingBalance: 100,
  riskPerTrade: 0.01,
  feeRate: 0.0005,
  autoPaperTrading: false,
  autoMinStrength: 75,
};
const CFG1000 = { ...CFG100, startingBalance: 1000 };

function accountRow(over: Partial<PaperAccountRow> = {}): PaperAccountRow {
  return {
    id: "acc-A",
    user_id: "user-A",
    starting_balance: 100,
    current_balance: 100,
    realized_pnl: 0,
    fees_paid: 0,
    closed_count: 0,
    wins: 0,
    peak_equity: 100,
    max_drawdown_pct: 0,
    risk_per_trade: 0.01,
    fee_rate: 0.0005,
    auto_paper_trading: false,
    auto_min_strength: 75,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...over,
  };
}

interface Scripted {
  data: unknown;
  error: { code?: string; message: string } | null;
}

/** Minimal chainable mock covering exactly what ensurePaperAccount touches. */
function scriptedClient(userId: string, selects: Scripted[], insertResult: Scripted, calls: string[], insertedRows: unknown[]) {
  const api = {
    auth: {
      getUser: async () => ({ data: { user: { id: userId } }, error: null }),
    },
    from: () => {
      let inserted: unknown = null;
      const builder = {
        select: () => {
          calls.push("select");
          return builder;
        },
        eq: () => {
          calls.push("eq");
          return builder;
        },
        insert: (row: unknown) => {
          calls.push("insert");
          inserted = row;
          insertedRows.push(row);
          return builder;
        },
        maybeSingle: async () => {
          calls.push("maybeSingle");
          if (inserted !== null) {
            inserted = null;
            return insertResult;
          }
          return selects.shift() ?? { data: null, error: null };
        },
      };
      return builder;
    },
  };
  return api as unknown as SupabaseClient;
}

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
    equity: 100,
    config: CFG100,
    at: 1700000000000,
  });
  if (!p) throw new Error("open failed");
  return p;
}

describe("ensurePaperAccount (mocked Supabase)", () => {
  it("returns the existing cloud account WITHOUT inserting (cloud $100 survives local $1000)", async () => {
    const calls: string[] = [];
    const insertedRows: unknown[] = [];
    const existing = accountRow();
    const sb = scriptedClient("user-A", [{ data: existing, error: null }], { data: null, error: null }, calls, insertedRows);
    // Device B passes its local default ($1000) — must NOT overwrite cloud.
    const { account, error } = await ensurePaperAccount(sb, 1000);
    expect(error).toBeNull();
    expect(account?.starting_balance).toBe(100);
    expect(account?.current_balance).toBe(100);
    expect(calls).not.toContain("insert");
    expect(insertedRows).toHaveLength(0);
  });

  it("creates a new account with the configured starting balance ($100, not forced $1000)", async () => {
    const calls: string[] = [];
    const insertedRows: unknown[] = [];
    const created = accountRow();
    const sb = scriptedClient("user-A", [{ data: null, error: null }], { data: created, error: null }, calls, insertedRows);
    const { account, error } = await ensurePaperAccount(sb, 100);
    expect(error).toBeNull();
    expect(account?.starting_balance).toBe(100);
    expect(calls).toContain("insert");
    const sent = insertedRows[0] as { starting_balance: number; current_balance: number; user_id: string };
    expect(sent.starting_balance).toBe(100);
    expect(sent.current_balance).toBe(100);
    expect(sent.user_id).toBe("user-A");
  });

  it("survives a create race (UNIQUE violation -> re-reads the winner, no duplicate)", async () => {
    const calls: string[] = [];
    const insertedRows: unknown[] = [];
    const existing = accountRow();
    const sb = scriptedClient(
      "user-A",
      [{ data: null, error: null }, { data: existing, error: null }],
      { data: null, error: { code: "23505", message: "duplicate key value" } },
      calls,
      insertedRows,
    );
    const { account, error } = await ensurePaperAccount(sb, 1000);
    expect(error).toBeNull();
    expect(account?.id).toBe("acc-A");
    expect(account?.starting_balance).toBe(100);
  });
});

describe("decideInitialLoad (cloud-wins policy)", () => {
  it("Test 4: cloud $100 + local $1000 default -> cloud replaces local", () => {
    const local = emptySnapshot(CFG1000); // fresh-device default singleton
    const cloudPos = positionToRow(makePosition(), "acc-A", "user-A", 108500);
    const decision = decideInitialLoad(local, accountRow(), [cloudPos], []);
    expect(decision.replace).toBe(true);
    if (decision.replace) {
      expect(decision.snapshot.balance).toBe(100);
      expect(decision.snapshot.config.startingBalance).toBe(100);
      expect(decision.snapshot.positions).toHaveLength(1);
      expect(decision.snapshot.positions[0].symbol).toBe("BTC");
    }
  });

  it("empty cloud + empty local -> keep local (fresh start, no phantom data)", () => {
    const decision = decideInitialLoad(emptySnapshot(CFG1000), accountRow(), [], []);
    expect(decision.replace).toBe(false);
    expect(decision.snapshot).toBeNull();
  });

  it("closed-trade history alone counts as cloud data (history never hidden)", () => {
    const p = { ...makePosition(), status: "CLOSED" as const, closedAt: 1700000001000, closeReason: "Manual." };
    const trade = closedToTradeRow(p, "acc-A", "user-A", 108700);
    const decision = decideInitialLoad(emptySnapshot(CFG1000), accountRow(), [], [trade]);
    expect(decision.replace).toBe(true);
  });
});

describe("row ownership (multi-user separation support)", () => {
  it("every position/trade row carries its user_id + account_id for RLS", () => {
    const p = makePosition();
    const pos = positionToRow(p, "acc-A", "user-A", null);
    expect(pos.user_id).toBe("user-A");
    expect(pos.account_id).toBe("acc-A");
    const closed = { ...p, status: "CLOSED" as const, closedAt: 1700000001000, closeReason: "x" };
    const trade = closedToTradeRow(closed, "acc-A", "user-A", null);
    expect(trade.user_id).toBe("user-A");
    expect(trade.account_id).toBe("acc-A");
  });
});

describe("engine persistence across restarts", () => {
  it("a saved $100 account survives a restart with $1000 defaults (no fake reset)", () => {
    const saved = emptySnapshot(CFG100);
    const store = {
      load: () => JSON.parse(JSON.stringify(saved)),
      save: () => {},
      clear: () => {},
    };
    const engine = new PaperEngine(CFG1000, store);
    expect(engine.getSnapshot().balance).toBe(100);
    expect(engine.getSnapshot().config.startingBalance).toBe(100);
  });

  it("Test 6: reset $73.40 -> $100 produces a $100 cloud patch", () => {
    const store = {
      load: () => null,
      save: () => {},
      clear: () => {},
    };
    const engine = new PaperEngine(CFG100, store);
    engine.replaceSnapshot({ ...emptySnapshot(CFG100), balance: 73.4, realizedPnl: -26.6 });
    engine.reset({ ...CFG100, startingBalance: 100 });
    const patch = snapshotToAccountPatch(engine.getSnapshot());
    expect(engine.getSnapshot().balance).toBe(100);
    expect(patch.current_balance).toBe(100);
    expect(patch.starting_balance).toBe(100);
  });
});
