import { describe, expect, it } from "vitest";
import { createSupabaseStateStore, type CronState } from "../state";

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  return (async (url: string, init?: RequestInit) => handler(url, init)) as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const URL = "https://db.example.test";
const KEY = "service-role-test-key";

describe("cron scanner_state store", () => {
  it("returns empty state when no row exists", async () => {
    const store = createSupabaseStateStore({
      url: URL,
      serviceKey: KEY,
      fetchFn: mockFetch(() => jsonResponse([])),
    });
    expect(await store.load()).toEqual({ seens: {}, cooldowns: {} });
  });

  it("loads a saved state and validates its shape", async () => {
    const saved: CronState = {
      seens: { crypto: { "BTC|LONG": { strength: 80, status: "ACTIVE", firstSeen: 1 } } },
      cooldowns: { "NEW_SIGNAL:crypto:BTC:LONG:15m:1-2:80": 2 },
    };
    const store = createSupabaseStateStore({
      url: URL,
      serviceKey: KEY,
      fetchFn: mockFetch(() => jsonResponse([{ value: saved }])),
    });
    expect(await store.load()).toEqual(saved);
  });

  it("rejects malformed rows instead of crashing the run", async () => {
    const store = createSupabaseStateStore({
      url: URL,
      serviceKey: KEY,
      fetchFn: mockFetch(() => jsonResponse([{ value: { nope: true } }])),
    });
    expect(await store.load()).toEqual({ seens: {}, cooldowns: {} });
  });

  it("upserts with merge-duplicates and surfaces HTTP failures", async () => {
    const seen: { url: string; init?: RequestInit }[] = [];
    const store = createSupabaseStateStore({
      url: URL,
      serviceKey: KEY,
      fetchFn: mockFetch((url, init) => {
        seen.push({ url, init });
        return jsonResponse({});
      }),
    });
    await store.save({ seens: {}, cooldowns: { a: 1 } });
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toContain("/rest/v1/scanner_state");
    expect((seen[0].init?.headers as Record<string, string>)?.Prefer).toContain("merge-duplicates");
    expect(String(seen[0].init?.body)).toContain("cron-monitor");

    const failing = createSupabaseStateStore({
      url: URL,
      serviceKey: KEY,
      fetchFn: mockFetch(() => jsonResponse({ error: "x" }, 500)),
    });
    await expect(failing.load()).rejects.toThrow("HTTP 500");
    await expect(failing.save({ seens: {}, cooldowns: {} })).rejects.toThrow("HTTP 500");
  });
});
