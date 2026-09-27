import { describe, expect, it } from "vitest";
import {
  findMarket,
  mergeDexMarkets,
  mergeLivePrices,
  normalizeAllMids,
  normalizeMarket,
  normalizeMetaAndAssetCtxs,
  normalizePerpDexs,
} from "../markets";
import { HyperliquidError } from "../types";

const META = {
  universe: [
    { name: "BTC", szDecimals: 5, maxLeverage: 50 },
    { name: "OP", szDecimals: 3, maxLeverage: 25 },
    { name: "DEAD", szDecimals: 1, isDelisted: true },
  ],
};

const CTXS = [
  {
    dayNtlVlm: "1000000",
    funding: "0.0001",
    markPx: "60000",
    midPx: "59990",
    openInterest: "100",
    oraclePx: "60010",
    prevDayPx: "58000",
  },
  {
    dayNtlVlm: "500000",
    funding: "-0.00002",
    markPx: "2",
    midPx: "2.001",
    openInterest: "1000000",
    oraclePx: "2.002",
    prevDayPx: "2.2",
  },
  {
    dayNtlVlm: "0",
    funding: "0",
    markPx: "1",
    midPx: "1",
    openInterest: "0",
    oraclePx: "1",
    prevDayPx: "1",
  },
];

describe("normalizeMetaAndAssetCtxs", () => {
  it("normalizes markets and skips delisted entries", () => {
    const markets = normalizeMetaAndAssetCtxs([META, CTXS]);
    expect(markets.map((m) => m.symbol)).toEqual(["BTC", "OP"]);
    const btc = markets[0];
    expect(btc.markPrice).toBe(60000);
    expect(btc.oraclePrice).toBe(60010);
    expect(btc.fundingRate).toBe(0.0001);
    expect(btc.openInterestCoins).toBe(100);
    expect(btc.openInterestNotional).toBeCloseTo(6_000_000);
    expect(btc.dayChangePct).toBeCloseTo(((60000 - 58000) / 58000) * 100);
  });

  it("computes negative 24h change and OI notional", () => {
    const markets = normalizeMetaAndAssetCtxs([META, CTXS]);
    const op = markets[1];
    expect(op.dayChangePct).toBeCloseTo(((2 - 2.2) / 2.2) * 100);
    expect(op.openInterestNotional).toBeCloseTo(2_000_000);
  });

  it("throws invalid-response on malformed payloads", () => {
    expect(() => normalizeMetaAndAssetCtxs(null)).toThrow(HyperliquidError);
    expect(() => normalizeMetaAndAssetCtxs([])).toThrow(HyperliquidError);
    expect(() => normalizeMetaAndAssetCtxs([{ universe: [] }, []])).toThrow(HyperliquidError);
  });

  it("degrades bad numbers to null instead of inventing prices", () => {
    const m = normalizeMarket({ name: "X", szDecimals: 2 }, { markPx: "abc", prevDayPx: "" });
    expect(m.markPrice).toBeNull();
    expect(m.dayChangePct).toBeNull();
    expect(m.openInterestNotional).toBeNull();
  });
});

describe("normalizeAllMids", () => {
  it("keeps finite numeric mids, drops garbage", () => {
    const mids = normalizeAllMids({ BTC: "60000.5", ETH: "3000", BAD: "xyz" });
    expect(mids).toEqual({ BTC: 60000.5, ETH: 3000 });
  });

  it("throws on non-object payloads", () => {
    expect(() => normalizeAllMids(null)).toThrow(HyperliquidError);
    expect(() => normalizeAllMids([])).toThrow(HyperliquidError);
  });
});

describe("mergeLivePrices", () => {
  it("merges ticks without mutating the input", () => {
    const base = normalizeMetaAndAssetCtxs([META, CTXS]);
    const merged = mergeLivePrices(base, { BTC: 61000 });
    expect(base[0].midPrice).toBe(59990);
    expect(merged[0].midPrice).toBe(61000);
    expect(merged[1].midPrice).toBe(2.001);
  });

  it("fills missing mark from live mids, ignores unknown symbols", () => {
    const base = normalizeMetaAndAssetCtxs([META, CTXS]);
    const withMissing = [{ ...base[0], markPrice: null }];
    const merged = mergeLivePrices(withMissing, { BTC: 61000, UNKNOWN: 5 });
    expect(merged[0].markPrice).toBe(61000);
  });
});

describe("findMarket", () => {
  it("finds case-insensitively and throws missing-market otherwise", () => {
    const markets = normalizeMetaAndAssetCtxs([META, CTXS]);
    expect(findMarket(markets, "op").symbol).toBe("OP");
    expect(() => findMarket(markets, "NOPE")).toThrowError(/not listed/);
  });
});

describe("normalizePerpDexs", () => {
  it("maps [null, {name}] to main-first dex list", () => {
    expect(normalizePerpDexs([null, { name: "xyz" }, { name: "test" }])).toEqual([
      "",
      "xyz",
      "test",
    ]);
  });

  it("dedupes and ignores malformed entries", () => {
    expect(
      normalizePerpDexs([{ name: "xyz" }, null, { name: "xyz" }, "junk", 5, { name: "" }]),
    ).toEqual(["", "xyz"]);
  });

  it("throws invalid-response on bad or empty payloads", () => {
    expect(() => normalizePerpDexs(null)).toThrow(HyperliquidError);
    expect(() => normalizePerpDexs([])).toThrow(HyperliquidError);
    expect(() => normalizePerpDexs(["junk"])).toThrow(HyperliquidError);
  });
});

describe("mergeDexMarkets", () => {
  const HIP3 = [
    {
      symbol: "xyz:XYZ100",
      markPrice: 25451,
      oraclePrice: 25372,
      dayVolumeNotional: 462.9,
      dayChangePct: -1.9,
      fundingRate: 0.0002,
      openInterestCoins: 0.0854,
      openInterestNotional: 2173.5,
      prevDayPrice: 25956,
      midPrice: 25451,
    },
    {
      symbol: "BTC",
      markPrice: 1,
      oraclePrice: 1,
      dayVolumeNotional: 10,
      dayChangePct: 0,
      fundingRate: 0,
      openInterestCoins: 1,
      openInterestNotional: 1,
      prevDayPrice: 1,
      midPrice: 1,
    },
  ];

  it("merges dex lists with first list winning on collision", () => {
    const main = normalizeMetaAndAssetCtxs([META, CTXS]);
    const markets = mergeDexMarkets([main, HIP3]);
    expect(markets.map((m) => m.symbol)).toEqual(["BTC", "OP", "xyz:XYZ100"]);
    // BTC keeps the main-dex snapshot, not the HIP-3 duplicate.
    expect(markets.find((m) => m.symbol === "BTC")?.markPrice).toBe(60000);
    expect(markets.find((m) => m.symbol === "xyz:XYZ100")?.fundingRate).toBe(0.0002);
  });

  it("throws invalid-response when nothing usable remains", () => {
    expect(() => mergeDexMarkets([])).toThrow(HyperliquidError);
    expect(() => mergeDexMarkets([[], []])).toThrow(HyperliquidError);
  });
});
