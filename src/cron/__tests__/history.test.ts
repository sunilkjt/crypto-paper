import { describe, expect, it } from "vitest";
import { createHistoryStore, type HistoryRow } from "../history";

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  return (async (url: string, init?: RequestInit) => handler(url, init)) as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const URL = "https://db.example.test";
const KEY = "service-role-test-key";

function row(): HistoryRow {
  return {
    id: "BTC|LONG|15m|TREND|1",
    category: "crypto",
    symbol: "BTC",
    direction: "LONG",
    score: 84,
    timeframe: "15m",
    entry_low: 98,
    entry_high: 100,
    invalidation: 95,
    tp1: 105,
    tp2: 110,
    tp3: 115,
    risk_reward: 2,
    setup_type: "TREND",
    quality: "MEDIUM QUALITY",
    entry_type: "MARKET",
    status: "NEW",
    first_seen: new Date(1000).toISOString(),
    last_seen: new Date(2000).toISOString(),
  };
}

describe("signal history store", () => {
  it("upserts rows idempotently and prunes by age", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const store = createHistoryStore({
      url: URL,
      serviceKey: KEY,
      fetchFn: mockFetch((url, init) => {
        calls.push({ url, init });
        return jsonResponse({});
      }),
    });
    await store.upsert([row()]);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("/rest/v1/signal_history");
    expect((calls[0].init?.headers as Record<string, string>)?.Prefer).toContain("merge-duplicates");
    const sent = JSON.parse(String(calls[0].init?.body)) as HistoryRow[];
    expect(sent[0].id).toBe("BTC|LONG|15m|TREND|1");
    expect(sent[0].category).toBe("crypto");

    await store.upsert([]);
    expect(calls).toHaveLength(1); // empty batch = no request

    await store.pruneOlderThanDays(30);
    expect(calls).toHaveLength(2);
    expect(calls[1].url).toContain("last_seen=lt.");
    expect(calls[1].init?.method).toBe("DELETE");
  });

  it("surfaces HTTP failures instead of hiding them", async () => {
    const store = createHistoryStore({
      url: URL,
      serviceKey: KEY,
      fetchFn: mockFetch(() => jsonResponse({}, 500)),
    });
    await expect(store.upsert([row()])).rejects.toThrow("HTTP 500");
    await expect(store.pruneOlderThanDays(30)).rejects.toThrow("HTTP 500");
  });
});
