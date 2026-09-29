import { describe, expect, it } from "vitest";
import { baseSymbol, classifyMarket, classifyMarkets } from "../classify";

// Main-dex mirror set as the live list would provide it (uppercase names).
const MAIN = new Set(["BTC", "ETH", "SOL", "QNT", "LITE", "COIN"]);

describe("market classification (evidence-based, exact-match only)", () => {
  it("treats unprefixed main-dex names as crypto", () => {
    expect(classifyMarket("BTC", MAIN)).toBe("crypto");
    expect(classifyMarket("eth", MAIN)).toBe("crypto");
    expect(baseSymbol("xyz:NVDA")).toBe("NVDA");
    expect(baseSymbol("BTC")).toBe("BTC");
  });

  it("treats HIP-3 mirrors of main-dex coins as crypto, not stocks", () => {
    expect(classifyMarket("flx:BTC", MAIN)).toBe("crypto");
    expect(classifyMarket("hyna:ETH", MAIN)).toBe("crypto");
    expect(classifyMarket("xyz:QNT", MAIN)).toBe("crypto");
  });

  it("classifies exact commodity base names (any dex)", () => {
    for (const s of ["xyz:GOLD", "flx:SILVER", "xyz:NATGAS", "km:USOIL", "xyz:WHEAT", "xyz:COPPER", "xyz:URANIUM", "xyz:TTF"]) {
      expect(classifyMarket(s, MAIN)).toBe("commodities");
    }
  });

  it("never substring-matches: GAS stays out of commodities", () => {
    expect(classifyMarket("flx:GAS", MAIN)).toBe("other");
    expect(classifyMarket("xyz:URANIUM", MAIN)).toBe("commodities");
    expect(classifyMarket("xyz:URNM", MAIN)).toBe("other");
  });

  it("routes indices, forex, vol and crypto baskets to other", () => {
    for (const s of ["xyz:SP500", "km:EUR", "xyz:VIX", "xyz:DXY", "para:TOTAL2", "km:USBOND", "xyz:VOL"]) {
      expect(classifyMarket(s, MAIN)).toBe("other");
    }
  });

  it("defaults remaining HIP-3 names to stocks", () => {
    for (const s of ["xyz:NVDA", "xyz:AAPL", "flx:TSLA", "io:NBIS", "vntl:OPENAI"]) {
      expect(classifyMarket(s, MAIN)).toBe("stocks");
    }
  });

  it("splits a mixed list with honest counts", () => {
    const out = classifyMarkets(["BTC", "xyz:NVDA", "xyz:GOLD", "xyz:EUR", "flx:BTC"], MAIN);
    expect(out.crypto).toEqual(["BTC", "flx:BTC"]);
    expect(out.stocks).toEqual(["xyz:NVDA"]);
    expect(out.commodities).toEqual(["xyz:GOLD"]);
    expect(out.other).toEqual(["xyz:EUR"]);
  });
});
