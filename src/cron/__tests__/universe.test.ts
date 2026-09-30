import { describe, expect, it } from "vitest";
import { buildUniverse, mainDexSymbols } from "../universe";
import type { Market } from "../../market/hyperliquid/types";

function market(symbol: string): Market {
  return {
    symbol,
    markPrice: 100,
    oraclePrice: 100,
    dayVolumeNotional: 1_000_000,
    dayChangePct: 1,
    fundingRate: 0,
    openInterestCoins: 10,
    openInterestNotional: 1000,
    prevDayPrice: 99,
    midPrice: 100,
  };
}

const LIST = ["BTC", "ETH", "xyz:NVDA", "xyz:AAPL", "xyz:GOLD", "xyz:NATGAS", "xyz:SP500", "xyz:EUR", "flx:BTC"].map(market);

describe("cron universe building", () => {
  it("splits live markets per category without mixing", () => {
    expect(buildUniverse(LIST, "crypto").map((m) => m.symbol).sort()).toEqual(["BTC", "ETH", "flx:BTC"]);
    expect(buildUniverse(LIST, "stocks").map((m) => m.symbol).sort()).toEqual(["xyz:AAPL", "xyz:NVDA"]);
    expect(buildUniverse(LIST, "commodities").map((m) => m.symbol).sort()).toEqual(["xyz:GOLD", "xyz:NATGAS"]);
  });

  it("never includes index/forex rows in any scanned category", () => {
    const all = [
      ...buildUniverse(LIST, "crypto"),
      ...buildUniverse(LIST, "stocks"),
      ...buildUniverse(LIST, "commodities"),
    ].map((m) => m.symbol);
    expect(all).not.toContain("xyz:SP500");
    expect(all).not.toContain("xyz:EUR");
  });

  it("main-dex set drives the crypto-mirror rule", () => {
    expect(mainDexSymbols(LIST).has("BTC")).toBe(true);
    expect(mainDexSymbols(LIST).has("XYZ:NVDA")).toBe(false);
  });
});
