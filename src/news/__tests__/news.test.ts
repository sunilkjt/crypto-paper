import { describe, expect, it } from "vitest";
import { aggregateNews } from "../provider";
import { coinKeywords, scoreRelevance } from "../relevance";
import { normalizeSentiment } from "../types";

describe("news normalization", () => {
  it("accepts verifiable records and drops the rest", () => {
    const out = aggregateNews("OP", [
      { id: "1", headline: "Optimism upgrade live", source: "Blog", url: "https://example.com/a", publishedAt: 10, symbol: "OP", summary: "s", sentiment: "POSITIVE" },
      { id: "", headline: "No id", source: "X", url: "https://example.com/b", publishedAt: 9 },
      { id: "3", headline: "No URL", source: "X", url: "http://insecure/x", publishedAt: 8 },
      { id: "1", headline: "Optimism upgrade live", source: "Blog", url: "https://example.com/a", publishedAt: 10 },
      "garbage",
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].sentiment).toBe("POSITIVE");
  });

  it("marks unknown dates as unavailable, never guessed", () => {
    const out = aggregateNews("OP", [
      { id: "1", headline: "Optimism news", source: "S", url: "https://example.com/a" },
    ]);
    expect(out[0].publishedAt).toBe(0);
  });

  it("defaults unknown sentiment to UNCERTAIN", () => {
    expect(normalizeSentiment("bogus")).toBe("UNCERTAIN");
    expect(normalizeSentiment("positive")).toBe("POSITIVE");
  });
});

describe("news relevance", () => {
  it("prefers OP/Optimism/Superchain stories for OP", () => {
    const direct = scoreRelevance("OP", "Optimism activates Superchain upgrade", "OP Mainnet throughput up");
    expect(direct.relevant).toBe(true);
    expect(direct.score).toBeGreaterThanOrEqual(0.75);
    expect(direct.matched).toContain("optimism");
  });

  it("does not surface unrelated BTC news as an OP catalyst", () => {
    const btc = scoreRelevance("OP", "Bitcoin ETF inflows hit record", "BTC demand surges");
    // Market-wide context at most — weak score, and aggregator keeps it only
    // if nothing better exists; never presented as an OP catalyst headline.
    expect(btc.score).toBeLessThanOrEqual(0.25);
    const none = scoreRelevance("OP", "Local weather report", "Sunny skies");
    expect(none.relevant).toBe(false);
  });

  it("knows major coin keyword maps", () => {
    expect(coinKeywords("OP")).toContain("superchain");
    expect(coinKeywords("BTC")).toContain("bitcoin");
    expect(coinKeywords("UNKNOWNCOIN")).toEqual(["unknowncoin"]);
  });

  it("sorts newest first with unknown dates last", () => {
    const out = aggregateNews("ETH", [
      { id: "old", headline: "Ethereum merge retrospective", source: "S", url: "https://example.com/1", publishedAt: 5 },
      { id: "new", headline: "Ethereum upgrade scheduled", source: "S", url: "https://example.com/2", publishedAt: 50 },
      { id: "nodate", headline: "Ethereum research notes", source: "S", url: "https://example.com/3" },
    ]);
    expect(out.map((n) => n.id)).toEqual(["new", "old", "nodate"]);
  });
});
