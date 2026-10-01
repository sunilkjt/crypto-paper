import { describe, expect, it } from "vitest";
import { createClaimTransport } from "../claims";
import { fingerprintOf } from "../../alerts/cooldown";
import { runOnce } from "../runner";
import type { CronState } from "../state";
import type { Market } from "../../market/hyperliquid/types";
import type { MarketCategory } from "../../market/classify";
import type { ScanSummary, ScannedCoin } from "../../scanner/engine";
import type { Signal } from "../../analysis/signal";
import type { SignalEvent } from "../../alerts/events";
import type { HistoryRow } from "../history";

/**
 * Atomic-claim contract tests. The true mutual exclusion lives in the
 * single-statement SQL upsert (migration 0005); here a fake store honoring
 * the IDENTICAL rule (insert, or refresh only when outside the window)
 * proves both consumers — one simulated browser claim fn, one cron claim
 * fn — share exactly one winner per fingerprint per window.
 */

function memoryServer() {
  const rows = new Map<string, number>();
  const key = (fp: string) => fp;
  return {
    rows,
    async claim(fp: string, cooldownMs: number, now: number): Promise<boolean> {
      const last = rows.get(key(fp));
      if (last !== undefined && now - last < Math.max(0, cooldownMs)) return false;
      rows.set(key(fp), now);
      return true;
    },
    release(fp: string): void {
      rows.delete(key(fp));
    },
  };
}

function fp(over: Partial<Parameters<typeof fingerprintOf>[0]> = {}): string {
  return fingerprintOf({
    type: "NEW_SIGNAL",
    category: "crypto",
    symbol: "BTC",
    direction: "LONG",
    timeframe: "15m",
    entryLow: 100,
    entryHigh: 101,
    strength: 84,
    ...over,
  });
}

describe("atomic claim semantics (shared fake store, SQL-identical rule)", () => {
  it("1-2: two simultaneous attempts, same fingerprint → exactly one winner", async () => {
    const server = memoryServer();
    const now = 1_000_000;
    const [a, b] = await Promise.all([server.claim(fp(), 1_800_000, now), server.claim(fp(), 1_800_000, now)]);
    // Single-threaded JS serializes the two awaits, mirroring what the
    // UNIQUE constraint guarantees across processes: one row wins.
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });

  it("3: different fingerprints are independent", async () => {
    const server = memoryServer();
    expect(await server.claim(fp(), 1_800_000, 1_000_000)).toBe(true);
    expect(await server.claim(fp({ symbol: "ETH" }), 1_800_000, 1_000_000)).toBe(true);
  });

  it("4: same symbol text in another category never collides", async () => {
    const server = memoryServer();
    expect(await server.claim(fp({ category: "stocks", symbol: "X" }), 1_800_000, 1_000_000)).toBe(true);
    expect(await server.claim(fp({ category: "commodities", symbol: "X" }), 1_800_000, 1_000_000)).toBe(true);
  });

  it("5: LONG vs SHORT are independent facts", async () => {
    const server = memoryServer();
    expect(await server.claim(fp({ direction: "LONG" }), 1_800_000, 1_000_000)).toBe(true);
    expect(await server.claim(fp({ direction: "SHORT" }), 1_800_000, 1_000_000)).toBe(true);
  });

  it("6-7: same fingerprint inside cooldown loses, after cooldown wins", async () => {
    const server = memoryServer();
    expect(await server.claim(fp(), 1_800_000, 1_000_000)).toBe(true);
    expect(await server.claim(fp(), 1_800_000, 1_000_001)).toBe(false);
    expect(await server.claim(fp(), 1_800_000, 1_000_000 + 1_800_000)).toBe(true);
  });

  it("8: failed delivery releases so a retry may proceed", async () => {
    const server = memoryServer();
    expect(await server.claim(fp(), 1_800_000, 1_000_000)).toBe(true);
    server.release(fp());
    expect(await server.claim(fp(), 1_800_000, 1_000_001)).toBe(true);
  });

  it("cooldown 0 disables suppression (always claimable)", async () => {
    const server = memoryServer();
    expect(await server.claim(fp(), 0, 1_000_000)).toBe(true);
    expect(await server.claim(fp(), 0, 1_000_000)).toBe(true);
  });
});

describe("browser + cron share one gate", () => {
  it("9: whichever worker claims first wins; the other is suppressed", async () => {
    const server = memoryServer();
    const now = 5_000_000;
    // Simulated browser claim path and cron claim path, same contract.
    const browserClaim = (f: string) => server.claim(f, 1_800_000, now);
    const cronClaim = (f: string) => server.claim(f, 1_800_000, now);
    expect(await browserClaim(fp())).toBe(true);
    expect(await cronClaim(fp())).toBe(false);
  });
});

describe("claim transport (REST shape)", () => {
  it("posts the claim RPC with params and maps true/false/error", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const mkFetch = (results: (boolean | Error)[]) =>
      (async (url: string, init?: RequestInit) => {
        const next = results.shift();
        if (next instanceof Error) throw next;
        calls.push({ url, body: JSON.parse(String(init?.body)) });
        return new Response(JSON.stringify(next), { status: 200 });
      }) as typeof fetch;
    const t = createClaimTransport({
      url: "https://db.example.test",
      serviceKey: "k",
      fetchFn: mkFetch([true]),
    });
    expect(await t.claim("fp-1", 1_800_000)).toBe(true);
    expect(calls[0].url).toContain("/rest/v1/rpc/claim_notification");
    expect(calls[0].body).toMatchObject({ p_fingerprint: "fp-1", p_cooldown_ms: 1_800_000 });

    const t2 = createClaimTransport({
      url: "https://db.example.test",
      serviceKey: "k",
      fetchFn: mkFetch([false]),
    });
    expect(await t2.claim("fp-1", 1_800_000)).toBe(false);

    const t3 = createClaimTransport({
      url: "https://db.example.test",
      serviceKey: "k",
      fetchFn: mkFetch([new Error("down")]),
    });
    expect(await t3.claim("fp-1", 1_800_000)).toBeNull();

    // Release never throws, even when the network fails.
    const t4 = createClaimTransport({
      url: "https://db.example.test",
      serviceKey: "k",
      fetchFn: mkFetch([new Error("down")]),
    });
    await expect(t4.release("fp-1")).resolves.toBeUndefined();
  });
});

function market(symbol: string, markPrice: number): Market {
  return {
    symbol,
    markPrice,
    oraclePrice: markPrice,
    dayVolumeNotional: 5_000_000,
    dayChangePct: 1,
    fundingRate: 0,
    openInterestCoins: 10,
    openInterestNotional: 1000,
    prevDayPrice: 99,
    midPrice: markPrice,
  };
}

function coin(symbol: string): ScannedCoin {
  return {
    symbol,
    signal: {
      symbol,
      direction: "LONG",
      signalStrength: 84,
      timeframe: "15m",
      entryLow: 98,
      entryHigh: 100,
      invalidation: 90,
      tp1: 110,
      tp2: 115,
      tp3: 120,
      riskReward: 2,
    } as unknown as Signal,
    setupType: "TREND",
    quality: "MEDIUM QUALITY",
    id: `${symbol}|LONG|15m|TREND|1`,
  };
}

function summaryFor(results: ScannedCoin[]): ScanSummary {
  return {
    status: "COMPLETE",
    startedAt: 1,
    completedAt: 2,
    setupTimeframe: "15m",
    results,
    scanned: results.length,
    excluded: [],
    error: null,
    breadth: { bullishPct: 0, bearishPct: 0, neutralPct: 0, counted: 0 },
  };
}

describe("runner atomic integration", () => {
  it("delivery failure releases the claim so a retry may proceed", async () => {
    const released: string[] = [];
    let saved: CronState | null = null;
    const settings = {
      categories: ["crypto"] as MarketCategory[],
      minStrength: 70 as const,
      directions: ["LONG"] as ("LONG" | "SHORT")[],
      cooldownMs: 1_800_000,
      universeCap: 60,
      concurrency: 2,
    };
    const failingDeliver = async (): Promise<{ delivered: number }> => {
      throw new Error("telegram down");
    };
    const report = await runOnce(settings, {
      now: 1_000_000,
      markets: [market("BTC", 97)],
      scanCategory: async () => summaryFor([coin("BTC")]),
      loadState: async () => ({ seens: {}, cooldowns: {} }),
      saveState: async (s) => {
        saved = s;
      },
      saveHistory: async (_rows: HistoryRow[]) => {},
      claim: async () => true,
      release: async (fp: string) => void released.push(fp),
      listChats: async () => ["chat-1"],
      deliver: failingDeliver,
      log: () => {},
    });
    expect(report.categories[0].errors.some((e) => e.includes("delivery"))).toBe(true);
    expect(released).toHaveLength(1);
    expect(saved).not.toBeNull();
  });

  it("transport failure falls back to the local cooldown map", async () => {
    const delivered: SignalEvent[] = [];
    let saved: CronState | null = null;
    const settings = {
      categories: ["crypto"] as MarketCategory[],
      minStrength: 70 as const,
      directions: ["LONG"] as ("LONG" | "SHORT")[],
      cooldownMs: 1_800_000,
      universeCap: 60,
      concurrency: 2,
    };
    const deps = {
      now: 1_000_000,
      markets: [market("BTC", 97)],
      scanCategory: async () => summaryFor([coin("BTC")]),
      loadState: async (): Promise<CronState> => saved ?? { seens: {}, cooldowns: {} },
      saveState: async (s: CronState) => {
        saved = JSON.parse(JSON.stringify(s)) as CronState;
      },
      saveHistory: async (_rows: HistoryRow[]) => {},
      claim: async (): Promise<boolean | null> => null, // gate unreachable
      release: async () => {},
      listChats: async () => ["chat-1"],
      deliver: async (events: SignalEvent[]) => {
        delivered.push(...events);
        return { delivered: events.length };
      },
      log: () => {},
    };
    const first = await runOnce(settings, deps);
    expect(first.totalDelivered).toBe(1);
    const second = await runOnce(settings, { ...deps, now: 1_000_001 });
    expect(second.totalDelivered).toBe(0); // locally recorded cooldown suppresses
  });
});
