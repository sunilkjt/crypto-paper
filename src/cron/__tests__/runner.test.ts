import { describe, expect, it } from "vitest";
import { runOnce, type CronSettings } from "../runner";
import type { CronState } from "../state";
import type { HistoryRow } from "../history";
import type { Market } from "../../market/hyperliquid/types";
import type { MarketCategory } from "../../market/classify";
import type { ScannedCoin, ScanSummary } from "../../scanner/engine";
import type { Signal } from "../../analysis/signal";
import type { SignalEvent } from "../../alerts/events";

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

function signal(symbol: string, direction: "LONG" | "SHORT", strength: number): Signal {
  // Bands leave the mark in a dead zone (no target touches) so each test
  // observes exactly the lifecycle events it intends.
  const long = direction === "LONG";
  return {
    symbol,
    direction,
    signalStrength: strength,
    timeframe: "15m",
    entryLow: 98,
    entryHigh: 100,
    invalidation: long ? 90 : 110,
    tp1: long ? 110 : 90,
    tp2: long ? 115 : 85,
    tp3: long ? 120 : 80,
    riskReward: 2,
  } as unknown as Signal;
}

function coin(symbol: string, direction: "LONG" | "SHORT", strength: number): ScannedCoin {
  return {
    symbol,
    signal: signal(symbol, direction, strength),
    setupType: "TREND",
    quality: "MEDIUM QUALITY",
    id: `${symbol}|${direction}|15m|TREND|1`,
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

const MARKETS = [market("BTC", 97), market("ETH", 103), market("xyz:AAPL", 97), market("xyz:GOLD", 97)];

function baseSettings(): CronSettings {
  return {
    categories: ["crypto", "stocks", "commodities"],
    minStrength: 70,
    directions: ["LONG", "SHORT"],
    cooldownMs: 1_800_000,
    universeCap: 60,
    concurrency: 2,
  };
}

interface Harness {
  saved: CronState | null;
  delivered: SignalEvent[];
  history: HistoryRow[];
  chats: string[];
  scans: MarketCategory[];
  summaries: Partial<Record<MarketCategory, ScanSummary>>;
  failOn: Set<MarketCategory>;
}

function harness(): Harness {
  return { saved: null, delivered: [], history: [], chats: ["chat-1"], scans: [], summaries: {}, failOn: new Set() };
}

function deps(h: Harness, now = 1_000_000) {
  return {
    now,
    markets: MARKETS,
    scanCategory: async (universe: Market[], category: MarketCategory): Promise<ScanSummary> => {
      h.scans.push(category);
      if (h.failOn.has(category)) throw new Error(`${category} exploded`);
      void universe;
      return h.summaries[category] ?? summaryFor([]);
    },
    loadState: async (): Promise<CronState> => h.saved ?? { seens: {}, cooldowns: {} },
    saveState: async (s: CronState): Promise<void> => {
      h.saved = JSON.parse(JSON.stringify(s)) as CronState;
    },
    claim: async (): Promise<boolean | null> => true,
    release: async (): Promise<void> => {},
    saveHistory: async (rows: HistoryRow[]): Promise<void> => {
      h.history.push(...rows);
    },
    listChats: async (): Promise<string[]> => h.chats,
    deliver: async (events: SignalEvent[], chats: string[]): Promise<{ delivered: number }> => {
      void chats;
      h.delivered.push(...events);
      return { delivered: events.length };
    },
    log: () => {},
  };
}

describe("headless runner", () => {
  it("delivers a new qualifying signal once, then suppresses repeats", async () => {
    const h = harness();
    h.summaries.crypto = summaryFor([coin("BTC", "LONG", 84)]);
    const d = deps(h);
    const first = await runOnce(baseSettings(), d);
    expect(first.totalDelivered).toBe(1);
    expect(h.delivered).toHaveLength(1);
    expect(h.delivered[0].symbol).toBe("BTC");
    expect(h.saved?.seens.crypto?.["BTC|LONG|15m|TREND|1"]?.status).toBeDefined();
    expect(Object.keys(h.saved?.cooldowns ?? {})).toHaveLength(1);

    const second = await runOnce(baseSettings(), deps(h, 1_000_001));
    expect(second.totalDelivered).toBe(0);
    expect(h.delivered).toHaveLength(1);
  });

  it("delivers fresh SHORT setups while LONG repeats stay silent", async () => {
    const h = harness();
    h.summaries.crypto = summaryFor([coin("BTC", "LONG", 84)]);
    await runOnce(baseSettings(), deps(h));
    h.summaries.crypto = summaryFor([
      coin("BTC", "LONG", 84),
      { ...coin("ETH", "SHORT", 81), id: "ETH|SHORT|15m|TREND|2" },
    ]);
    const res = await runOnce(baseSettings(), deps(h, 2_000_000));
    expect(res.totalDelivered).toBe(1);
    expect(h.delivered.map((e) => e.symbol)).toEqual(["BTC", "ETH"]);
  });

  it("respects disabled categories and minimum strength (signals untouched)", async () => {
    const h = harness();
    h.summaries.stocks = summaryFor([coin("xyz:AAPL", "LONG", 84)]);
    h.summaries.commodities = summaryFor([coin("xyz:GOLD", "LONG", 60)]);
    const s = baseSettings();
    s.categories = ["crypto", "stocks"];
    const res = await runOnce(s, deps(h));
    // AAPL passes; GOLD is below min strength anyway.
    expect(h.delivered.map((e) => e.symbol)).toEqual(["xyz:AAPL"]);
    expect(res.categories.find((c) => c.category === "stocks")?.delivered).toBe(1);

    const h2 = harness();
    h2.summaries.stocks = summaryFor([coin("xyz:AAPL", "LONG", 84)]);
    const s2 = baseSettings();
    s2.categories = ["crypto"];
    await runOnce(s2, deps(h2));
    expect(h2.delivered).toHaveLength(0);
    // …and disabled categories do nothing at all: no scan, no state writes.
    expect(h2.scans).not.toContain("stocks");
    expect(h2.saved?.seens.stocks).toBeUndefined();
  });

  it("saves state with zero chats linked (no backfill spam later)", async () => {
    const h = harness();
    h.chats = [];
    h.summaries.crypto = summaryFor([coin("BTC", "LONG", 84)]);
    const res = await runOnce(baseSettings(), deps(h));
    expect(res.totalDelivered).toBe(0);
    expect(h.saved?.seens.crypto?.["BTC|LONG|15m|TREND|1"]).toBeDefined();
  });

  it("isolates per-category failures and keeps scanning the rest", async () => {
    const h = harness();
    h.failOn.add("stocks");
    h.summaries.crypto = summaryFor([coin("BTC", "LONG", 84)]);
    h.summaries.stocks = summaryFor([coin("xyz:AAPL", "LONG", 84)]);
    const res = await runOnce(baseSettings(), deps(h));
    expect(res.totalDelivered).toBe(1);
    const stocks = res.categories.find((c) => c.category === "stocks");
    expect(stocks?.errors).toHaveLength(1);
    expect(h.scans).toContain("crypto");
  });

  it("scans only the requested categories", async () => {
    const h = harness();
    const s = baseSettings();
    s.categories = ["commodities"];
    await runOnce(s, deps(h));
    expect(h.scans).toEqual(["commodities"]);
  });

  it("reports candidates, rejections and a heartbeat for /status", async () => {
    const h = harness();
    h.summaries.crypto = summaryFor([coin("BTC", "LONG", 84), coin("ETH", "LONG", 55)]);
    const res = await runOnce(baseSettings(), deps(h, 9_000_000));
    const rep = res.categories.find((c) => c.category === "crypto");
    expect(rep?.candidates).toBe(2);
    expect(rep?.rejections.LOW_SCORE).toBe(1);
    expect(h.saved?.lastRun?.at).toBe(9_000_000);
    expect(h.saved?.lastRun?.perCategory.crypto).toMatchObject({ signals: 2 });
    expect(h.saved?.lastRun?.lastDeliveryAt).toBe(9_000_000);
    expect(h.history).toHaveLength(1); // only the >=70 signal is stored
  });

  it("rounds fractional scores to the integer history column (thresholds use raw floats)", async () => {
    const h = harness();
    // 76.5 qualifies against the 70 bar on its raw float, persists as 77.
    h.summaries.crypto = summaryFor([coin("BTC", "LONG", 76.5), coin("ETH", "LONG", 69.4)]);
    await runOnce(baseSettings(), deps(h));
    expect(h.history.map((r) => [r.symbol, r.score])).toEqual([["BTC", 77]]);
  });

  it("persists signal history independent of delivery", async () => {    const h = harness();
    // Delivery fails, but the qualifying signal must still land in history.
    const failingDeliver = {
      ...deps(h),
      deliver: async (): Promise<{ delivered: number }> => {
        throw new Error("telegram down");
      },
    };
    h.summaries.crypto = summaryFor([coin("BTC", "LONG", 84)]);
    // Runner catches per-event? No — deliver throws for the batch; the run
    // must still record history and state (verified below via try/catch path).
    const res = await runOnce(baseSettings(), failingDeliver).catch(() => null);
    void res;
    // History write happens before delivery, so it survives delivery failure.
    expect(h.history.map((r) => r.id)).toEqual(["BTC|LONG|15m|TREND|1"]);
    const row = h.history[0];
    expect(row.category).toBe("crypto");
    expect(row.symbol).toBe("BTC");
    expect(row.score).toBe(84);
    expect(row.entry_low).toBe(98);
  });

  it("records heartbeat and preserves last delivery time", async () => {
    const h = harness();
    h.summaries.crypto = summaryFor([coin("BTC", "LONG", 84)]);
    await runOnce(baseSettings(), deps(h, 5_000_000));
    expect(h.saved?.lastRun?.at).toBe(5_000_000);
    expect(h.saved?.lastRun?.perCategory.crypto).toMatchObject({ scanned: 1, signals: 1 });
    expect(h.saved?.lastRun?.delivered).toBe(1);
    expect(h.saved?.lastRun?.lastDeliveryAt).toBe(5_000_000);

    // Quiet run: heartbeat advances, delivery time is preserved.
    h.summaries.crypto = summaryFor([]);
    await runOnce(baseSettings(), deps(h, 6_000_000));
    expect(h.saved?.lastRun?.at).toBe(6_000_000);
    expect(h.saved?.lastRun?.delivered).toBe(0);
    expect(h.saved?.lastRun?.lastDeliveryAt).toBe(5_000_000);
  });
});
