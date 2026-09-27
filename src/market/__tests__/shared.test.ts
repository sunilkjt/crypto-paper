import { afterEach, describe, expect, it, vi } from "vitest";
import { clearCache } from "../cache";
import { getCachedCandles } from "../hyperliquid";
import { readDiagnostics, resetDiagnosticsForTests } from "../diagnostics";

function rawCandle(t: number, c: number): Record<string, unknown> {
  return { t, T: t + 1, s: "BTC", i: "15m", o: "1", h: "2", l: "0.5", c: String(c), v: "10", n: 1 };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("shared candle requests", () => {
  it("Scanner + Chart + Signal + Coin + History share ONE fetch", async () => {
    resetDiagnosticsForTests();
    clearCache();
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() =>
        Promise.resolve(
          new Response(JSON.stringify([rawCandle(1, 1), rawCandle(2, 2), rawCandle(3, 3)]), { status: 200 }),
        ).then((r) => {
          calls += 1;
          return r;
        }),
      ),
    );
    // Five consumers, near-identical millisecond windows (same 15m grid).
    const base = 1_700_000_000_000;
    const results = await Promise.all(
      [0, 400, 900, 1500, 2100].map((off) =>
        getCachedCandles("BTC", "15m", base + off, base + off + 300 * 900_000),
      ),
    );
    expect(calls).toBe(1);
    for (const r of results) expect(r.candles).toHaveLength(3);
    // A repeat sequential call is a pure cache hit (no fetch).
    await getCachedCandles("BTC", "15m", base + 50, base + 300 * 900_000);
    expect(calls).toBe(1);
    const snap = readDiagnostics();
    expect(snap.cacheMisses).toBe(1);
    expect(snap.cacheHits).toBeGreaterThanOrEqual(5);
    expect(snap.restRequests).toBe(1);
  });

  it("different timeframes still fetch separately", async () => {
    resetDiagnosticsForTests();
    clearCache();
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => {
        calls += 1;
        return Promise.resolve(
          new Response(JSON.stringify([rawCandle(1, 1), rawCandle(2, 2)]), { status: 200 }),
        );
      }),
    );
    await getCachedCandles("BTC", "15m", 1_700_000_000_000, 1_700_010_000_000);
    await getCachedCandles("BTC", "1h", 1_700_000_000_000, 1_700_010_000_000);
    expect(calls).toBe(2);
  });
});
