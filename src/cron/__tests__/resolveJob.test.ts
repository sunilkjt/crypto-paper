import { describe, expect, it } from "vitest";
import type { Candle, Timeframe } from "../../market/hyperliquid/types";
import { runResolverJob, type ResolverHeartbeat } from "../resolveJob";
import type { UnresolvedRowLike } from "../../analytics/resolve";
import type { ResolvePatch } from "../../analytics/resolve";

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
    entry_type: null,
    invalidation: 95,
    tp1: 105,
    tp2: 110,
    tp3: 115,
    first_seen: new Date(T0).toISOString(),
    outcome: null,
    ...over,
  };
}

interface Fake {
  rows: UnresolvedRowLike[];
  candles: Candle[];
  patches: { id: string; patch: ResolvePatch }[];
  heartbeats: ResolverHeartbeat[];
  failPatch: boolean;
  failHeartbeat: boolean;
  failList: boolean;
  failCandles: boolean;
}

function fake(over: Partial<Fake> = {}) {
  const f: Fake = {
    rows: [row()],
    candles: [candle(T0 + H, 106, 101), candle(T0 + 2 * H, 111, 106), candle(T0 + 3 * H, 116, 111)],
    patches: [],
    heartbeats: [],
    failPatch: false,
    failHeartbeat: false,
    failList: false,
    failCandles: false,
    ...over,
  };
  return {
    f,
    deps: {
      now: T0 + 4 * H,
      lifetimeMs: LIFETIME,
      concurrency: 2,
      listUnresolved: async (): Promise<UnresolvedRowLike[]> => {
        if (f.failList) throw new Error("db down");
        return f.rows;
      },
      fetchCandles: async (): Promise<Candle[]> => {
        if (f.failCandles) throw new Error("candles down");
        return f.candles;
      },
      patchRow: async (id: string, patch: ResolvePatch): Promise<boolean> => {
        if (f.failPatch) return false;
        f.patches.push({ id, patch });
        return true;
      },
      writeHeartbeat: async (hb: ResolverHeartbeat): Promise<void> => {
        if (f.failHeartbeat) throw new Error("heartbeat store down");
        f.heartbeats.push(hb);
      },
      log: () => {},
    },
  };
}

describe("runResolverJob heartbeat contract", () => {
  it("writes a heartbeat even when there is nothing unresolved", async () => {
    const { f, deps } = fake({ rows: [] });
    const counts = await runResolverJob(deps);
    expect(counts).toMatchObject({ checked: 0, resolved: 0, ok: true });
    expect(f.heartbeats).toHaveLength(1);
    expect(f.heartbeats[0]).toMatchObject({ checked: 0, resolved: 0, failed: 0 });
    expect(f.patches).toHaveLength(0);
  });

  it("writes a heartbeat when every row fails (failure stays visible)", async () => {
    const { f, deps } = fake({ failPatch: true });
    const counts = await runResolverJob(deps);
    expect(counts).toMatchObject({ checked: 1, resolved: 0, failed: 1, ok: true });
    expect(f.heartbeats).toHaveLength(1);
    expect(f.heartbeats[0].failed).toBe(1);
  });

  it("writes a heartbeat with an error note when listing fails", async () => {
    const { f, deps } = fake({ failList: true });
    const counts = await runResolverJob(deps);
    expect(counts.ok).toBe(false);
    expect(f.heartbeats).toHaveLength(1);
    expect(f.heartbeats[0].error).toMatch(/db down/);
  });

  it("survives a failing heartbeat store without failing the run", async () => {
    const { f, deps } = fake({ failHeartbeat: true });
    const counts = await runResolverJob(deps);
    expect(counts).toMatchObject({ checked: 1, resolved: 1, ok: true });
    expect(f.patches).toHaveLength(1);
  });

  it("isolates per-row candle failures (one bad symbol never blocks the rest)", async () => {
    const { f, deps } = fake({
      rows: [row({ id: "good" }), row({ id: "bad", symbol: "DEAD" })],
    });
    const failOnDead = {
      ...deps,
      fetchCandles: async (symbol: string, _tf: Timeframe, _from: number, _to: number): Promise<Candle[]> => {
        if (symbol === "DEAD") throw new Error("no data");
        return f.candles;
      },
    };
    // DEAD within lifetime with no candles → transient skip; good resolves.
    const counts = await runResolverJob({ ...failOnDead, now: T0 + 4 * H });
    expect(counts.resolved).toBe(1);
    expect(f.patches.map((p) => p.id)).toEqual(["good"]);
    expect(f.heartbeats).toHaveLength(1);
  });

  it("never rewrites already-resolved rows (duplicate execution safe)", async () => {
    const resolvedRow = row({ id: "done", outcome: "WIN" });
    const seen: UnresolvedRowLike[] = [resolvedRow];
    const { f, deps } = fake({ rows: seen });
    const first = await runResolverJob(deps);
    // Belt-and-braces guard skips it without counting or patching.
    expect(first.resolved).toBe(0);
    expect(f.patches).toHaveLength(0);
    // Second identical run behaves identically.
    const second = await runResolverJob(deps);
    expect(second).toEqual(first);
    expect(f.heartbeats).toHaveLength(2);
  });

  it("resolves terminal verdicts with full patch fields", async () => {
    const { f, deps } = fake();
    const counts = await runResolverJob(deps);
    expect(counts).toMatchObject({ checked: 1, resolved: 1, failed: 0, ok: true });
    expect(f.patches[0].patch).toMatchObject({ outcome: "WIN" });
    expect(typeof f.patches[0].patch.decided_by).toBe("string");
  });
});
