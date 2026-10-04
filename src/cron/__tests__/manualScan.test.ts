import { describe, expect, it } from "vitest";
import type { Market } from "../../market/hyperliquid/types";
import handlerSrc from "../../../supabase/functions/telegram-scan/handler.src.ts?raw";import { buildSignal } from "../../analysis/signal";
import { candlesFromCloses, uptrend } from "../../analysis/__tests__/helpers";
import type { MarketCategory } from "../../market/classify";
import type { ScanSummary } from "../../scanner/engine";
import {
  DEFAULT_SCAN_LIMIT,
  MANUAL_TRADE_MIN_STRENGTH,
  MAX_SCAN_LIMIT,
  ManualScanError,
  formatManualScanResult,
  parseScanArgs,
  runManualMarketScan,
  verifyScanAccess,
  type ManualScanDeps,
  type ManualScanResult,
  type ScanRequest,
} from "../manualScan";

function market(symbol: string): Market {
  return {
    symbol,
    markPrice: 100,
    oraclePrice: 100,
    midPrice: 100,
    prevDayPrice: 99,
    dayChangePct: 1,
    dayVolumeNotional: 10_000_000,
    fundingRate: 0.0001,
    openInterestCoins: 1000,
    openInterestNotional: 100_000,
  };
}

/**Deterministic engine-built summary over the given symbols (real scoring). */
function engineSummary(symbols: string[]): ScanSummary {
  const closes = uptrend(260);
  const candles = candlesFromCloses(closes);
  const byTf = { "4h": candles, "1h": candles, "15m": candles, "5m": candles };
  const results = symbols.map((symbol) => {
    const { signal } = buildSignal({ symbol, setupTimeframe: "15m", candlesByTf: byTf });
    return { symbol, signal, setupType: "TREND" as const, quality: "MEDIUM QUALITY" as const, id: `${symbol}|x` };
  });
  return {
    status: "COMPLETE",
    startedAt: 1,
    completedAt: 2,
    setupTimeframe: "15m",
    results,
    scanned: results.length,
    excluded: [],
    error: null,
    breadth: { bullishPct: 0, bearishPct: 0, neutralPct: 0, counted: results.length },
  };
}

function deps(over?: Partial<ManualScanDeps>): ManualScanDeps {
  return {
    now: 1_800_000_000_000,
    listMarkets: async () => ({
      markets: [market("BTC"), market("ETH"), market("xyz:NVDA"), market("xyz:AAPL"), market("xyz:GOLD")],
      updatedAt: 1_800_000_000_000,
    }),
    scanCategory: async (universe: Market[], _category: MarketCategory) =>
      engineSummary(universe.map((m) => m.symbol)),
    ...over,
  };
}

const req = (over?: Partial<ScanRequest>): ScanRequest => ({
  categories: ["crypto", "stocks", "commodities"],
  direction: "ALL",
  tradeOnly: false,
  limit: 10,
  ...over,
});

describe("parseScanArgs", () => {
  it("defaults bare /scan to all categories, top 10", () => {
    expect(parseScanArgs("")).toEqual({
      categories: ["crypto", "stocks", "commodities"],
      direction: "ALL",
      tradeOnly: false,
      limit: DEFAULT_SCAN_LIMIT,
    });
    expect(DEFAULT_SCAN_LIMIT).toBe(10);
  });

  it("parses category filters", () => {
    expect(parseScanArgs("crypto").categories).toEqual(["crypto"]);
    expect(parseScanArgs("stocks").categories).toEqual(["stocks"]);
    expect(parseScanArgs("commodities").categories).toEqual(["commodities"]);
  });

  it("parses direction and trade mode", () => {
    expect(parseScanArgs("long").direction).toBe("LONG");
    expect(parseScanArgs("short").direction).toBe("SHORT");
    expect(parseScanArgs("trade").tradeOnly).toBe(true);
  });

  it("parses limits and clamps to 1..20", () => {
    expect(parseScanArgs("5").limit).toBe(5);
    expect(parseScanArgs("10").limit).toBe(10);
    expect(parseScanArgs("20").limit).toBe(20);
    expect(parseScanArgs("99").limit).toBe(MAX_SCAN_LIMIT);
    expect(parseScanArgs("0").limit).toBe(1);
    expect(parseScanArgs("abc").limit).toBe(DEFAULT_SCAN_LIMIT);
  });

  it("supports combined filters case-insensitively", () => {
    expect(parseScanArgs("stocks long")).toEqual({
      categories: ["stocks"],
      direction: "LONG",
      tradeOnly: false,
      limit: 10,
    });
    expect(parseScanArgs("CRYPTO SHORT 10")).toEqual({
      categories: ["crypto"],
      direction: "SHORT",
      tradeOnly: false,
      limit: 10,
    });
    expect(parseScanArgs("Trade 5")).toEqual({
      categories: ["crypto", "stocks", "commodities"],
      direction: "ALL",
      tradeOnly: true,
      limit: 5,
    });
    expect(parseScanArgs("stocks 5")).toEqual({
      categories: ["stocks"],
      direction: "ALL",
      tradeOnly: false,
      limit: 5,
    });
  });

  it("ignores unknown tokens instead of guessing", () => {
    expect(parseScanArgs("bananas")).toEqual(parseScanArgs(""));
  });
});

describe("runManualMarketScan behavior", () => {
  it("scans requested categories and ranks by engine score", async () => {
    const res = await runManualMarketScan(deps(), req({ categories: ["crypto"] }));
    expect(res.perCategory.map((c) => c.category)).toEqual(["crypto"]);
    expect(res.marketsDiscovered).toBe(5);
    const scores = res.candidates.map((c) => c.signal.signalStrength);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  it("filters direction without converting WAIT", async () => {
    const longs = await runManualMarketScan(deps(), req({ direction: "LONG", limit: 20 }));
    expect(longs.candidates.every((c) => c.signal.direction === "LONG")).toBe(true);
    const shorts = await runManualMarketScan(deps(), req({ direction: "SHORT", limit: 20 }));
    expect(shorts.candidates.every((c) => c.signal.direction === "SHORT")).toBe(true);
    // WAIT never appears as a directional candidate.
    expect(longs.candidates.some((c) => c.signal.direction === "WAIT")).toBe(false);
  });

  it("trade-only keeps qualified directionals and never WAIT", async () => {
    const res = await runManualMarketScan(deps(), req({ tradeOnly: true, limit: 20 }));
    for (const c of res.candidates) {
      expect(c.signal.direction === "LONG" || c.signal.direction === "SHORT").toBe(true);
      expect(c.signal.signalStrength).toBeGreaterThanOrEqual(MANUAL_TRADE_MIN_STRENGTH);
    }
    expect(res.watch).toEqual([]);
  });

  it("preserves the DEX namespace (xyz:NVDA, xyz:GOLD)", async () => {
    const res = await runManualMarketScan(deps(), req({ categories: ["stocks", "commodities"], limit: 20 }));
    const symbols = res.candidates.map((c) => c.symbol);
    expect(symbols).toContain("xyz:NVDA");
    expect(symbols).toContain("xyz:GOLD");
    expect(symbols.some((s) => s === "NVDA" || s === "GOLD")).toBe(false);
  });

  it("a failing category does not abort the others (partial, honest)", async () => {
    const res = await runManualMarketScan(
      deps({
        scanCategory: async (universe: Market[], category: MarketCategory) => {
          if (category === "stocks") throw new Error("boom");
          return engineSummary(universe.map((m) => m.symbol));
        },
      }),
      req(),
    );
    expect(res.partial).toBe(true);
    expect(res.failures.join("")).toMatch(/stocks/);
    expect(res.candidates.length).toBeGreaterThan(0);
  });

  it("throws ManualScanError (never stale data) when markets are unavailable", async () => {
    const d = deps({ listMarkets: async () => { throw new Error("down"); } });
    await expect(runManualMarketScan(d, req())).rejects.toBeInstanceOf(ManualScanError);
    const empty = deps({ listMarkets: async () => ({ markets: [], updatedAt: 0 }) });
    await expect(runManualMarketScan(empty, req())).rejects.toBeInstanceOf(ManualScanError);
  });

  it("does not consult cooldowns and has no persistence seam", async () => {
    // By construction: ManualScanDeps exposes listMarkets + scanCategory
    // only — no claim, no saveHistory, no saveState. A scan that just ran
    // still returns the same strongest setups (no suppression).
    const d = deps();
    const first = await runManualMarketScan(d, req());
    const second = await runManualMarketScan(d, req());
    expect(second.candidates.map((c) => c.symbol)).toEqual(first.candidates.map((c) => c.symbol));
    for (const forbidden of ["claim", "release", "saveHistory", "saveState", "cooldowns", "deliver"]) {
      expect(d).not.toHaveProperty(forbidden);
    }
  });
});

describe("formatManualScanResult", () => {
  async function full(): Promise<ManualScanResult> {
    return runManualMarketScan(deps(), req({ limit: 10 }));
  }

  it("renders the compact scan format with real engine fields", async () => {
    const text = formatManualScanResult(await full());
    expect(text).toMatch(/🔎 MARKET SCAN/);
    expect(text).toMatch(/Scanned: \d+ markets/);
    expect(text).toMatch(/Category: ALL/);
    expect(text).toMatch(/Timeframe: 15M/);
    expect(text).toMatch(/Generated: \d{2}:\d{2} UTC/);
    expect(text).toMatch(/Score: [\d.]+/);
    expect(text).toMatch(/\/100/);
    expect(text).toMatch(/Reasons:/);
    expect(text).toMatch(/Showing top \d+ of \d+ candidates\./);
  });

  it("trade mode with nothing qualified says so with real counts", async () => {
    // Scan ran fine (5 markets scored) but the engine verdict is WAIT
    // everywhere — the template must say so with real counts, not invent.
    const d = deps({
      scanCategory: async (universe: Market[]) => {
        const s = engineSummary(universe.map((m) => m.symbol));
        return {
          ...s,
          results: s.results.map((r) => ({
            ...r,
            signal: { ...r.signal, direction: "WAIT" as const, signalStrength: 50 },
          })),
          scanned: s.results.length,
        };
      },
    });
    const text = formatManualScanResult(await runManualMarketScan(d, req({ tradeOnly: true })));
    expect(text).toMatch(/No qualified trade setups right now/);
    expect(text).toMatch(/Markets scanned: 5/);
    expect(text).toMatch(/LONG candidates: 0/);
    expect(text).toMatch(/SHORT candidates: 0/);
  });
});

describe("verifyScanAccess (security)", () => {
  it("rejects unpaired and paused chats, allows paired+enabled", async () => {
    const lookup = async (chat: string) => {
      if (chat === "paired") return { paired: true, enabled: true };
      if (chat === "paused") return { paired: true, enabled: false };
      return { paired: false, enabled: false };
    };
    expect(await verifyScanAccess(lookup, "nope")).toEqual({ ok: false, reason: "unpaired" });
    expect(await verifyScanAccess(lookup, "paused")).toEqual({ ok: false, reason: "paused" });
    expect(await verifyScanAccess(lookup, "paired")).toEqual({ ok: true, reason: null });
  });
});

describe("scan edge handler guards", () => {
  // Documentation comments name the forbidden systems; the assertions
  // below run against comment-stripped code (mechanisms, not mentions).
  const code = handlerSrc
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  it("requires service-role auth and re-validates pairing", () => {
    expect(handlerSrc).toMatch(/Bearer \${serviceKey}/);
    expect(handlerSrc).toMatch(/verifyScanAccess/);
    expect(handlerSrc).toMatch(/telegram_connections\?telegram_chat_id/);
  });

  it("uses the bundled deterministic engine (never a copy)", () => {
    expect(handlerSrc).toMatch(/runFullScan/);
    expect(handlerSrc).toMatch(/getMarkets/);
    expect(handlerSrc).toMatch(/runManualMarketScan/);
  });

  it("writes nothing to history/state and consults no cooldown gate", () => {
    expect(code).not.toMatch(/signal_history/);
    expect(code).not.toMatch(/saveHistory/);
    expect(code).not.toMatch(/saveState/);
    expect(code).not.toMatch(/fingerprintOf/);
    expect(code).not.toMatch(/isOutsideCooldown/);
    expect(code).not.toMatch(/notification_claims/);
    expect(code).not.toMatch(/scanner_state/);
    // The only Supabase access is the pairing GET (Bot API POSTs are replies).
    expect(code.match(/\/rest\/v1\//g)?.length ?? 0).toBe(1);
    expect(code).not.toMatch(/"PATCH"/);
  });

  it("sends no secrets and caps output chunks", () => {
    expect(handlerSrc).not.toMatch(/console\.log\(.*token/i);
    expect(handlerSrc).toMatch(/slice\(0, 3500\)/);
    expect(handlerSrc).toMatch(/editMessageText/);
  });
});
