import { postInfoWithRetry } from "./client";
import { normalizeAllMids, normalizeMetaAndAssetCtxs, normalizePerpDexs, mergeDexMarkets } from "./markets";
import type { Market, Timeframe } from "./types";
import { cached, CACHE_TTL } from "../cache";
import { getCandles } from "./candles";
import { timeframeToMs } from "./timeframes";
import type { Candle } from "./types";
import { HyperliquidError } from "./types";

/** Dex list changes rarely — cached much longer than market snapshots. */
const DEX_LIST_TTL_MS = 10 * 60 * 1000;

/** Max parallel REST calls in one fan-out (bursts trip the 429 limiter). */
const DEX_FANOUT_LIMIT = 4;

/**
 * getMarkets(): full perpetual universe with mark/oracle, 24h volume,
 * 24h change, funding and open interest. Never hardcoded.
 * Covers the main dex plus HIP-3 builder dexes (e.g. xyz:*) via the
 * dex list + one metaAndAssetCtxs call per dex. A dex that fails is
 * skipped; if every dex fails the first error is surfaced.
 * Note: live WS mids cover the main dex — HIP-3 rows refresh on the
 * snapshot poll instead.
 */
export async function getMarkets(opts?: {
  timeoutMs?: number;
  signal?: AbortSignal;
  bypassCache?: boolean;
}): Promise<{ markets: Market[]; updatedAt: number }> {
  const run = async () => {
    let dexes: string[];
    try {
      dexes = await cached("hl:perpDexs", DEX_LIST_TTL_MS, async () => {
        const payload = await postInfoWithRetry({ type: "perpDexs" }, opts);
        return normalizePerpDexs(payload);
      });
    } catch (err) {
      if (err instanceof HyperliquidError && !err.retryable) throw err;
      dexes = [""];
    }

    // Bounded fan-out: 11 simultaneous per-dex POSTs was a major 429
    // contributor. Results stream in as workers free up; index slots keep
    // main-dex-first priority for the first-wins merge below.
    const slots: (Market[] | null)[] = new Array(dexes.length).fill(null);
    let firstError: unknown = null;
    let next = 0;
    const fetchOne = async (dex: string): Promise<Market[]> => {
      const payload = await postInfoWithRetry(
        dex === "" ? { type: "metaAndAssetCtxs" } : { type: "metaAndAssetCtxs", dex },
        opts,
      );
      return normalizeMetaAndAssetCtxs(payload);
    };
    const workers = Array.from(
      { length: Math.min(DEX_FANOUT_LIMIT, dexes.length) },
      async () => {
        while (next < dexes.length) {
          const i = next++;
          try {
            slots[i] = await fetchOne(dexes[i]);
          } catch (err) {
            if (firstError === null) firstError = err;
          }
        }
      },
    );
    await Promise.all(workers);
    const lists = slots.filter((l): l is Market[] => l !== null);
    if (lists.length === 0) {
      if (firstError instanceof HyperliquidError) throw firstError;
      throw new HyperliquidError(
        "api",
        "Unable to retrieve Hyperliquid market data. Retrying…",
        true,
      );
    }
    return {
      markets: mergeDexMarkets(lists),
      updatedAt: Date.now(),
    };
  };
  if (opts?.bypassCache) return run();
  return cached("hl:markets", CACHE_TTL.marketsMs, run);
}

/** Lightweight mid-price refresh (merged into the snapshot by the store). */
export async function getAllMids(opts?: {
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<{ mids: Record<string, number>; updatedAt: number }> {
  const payload = await postInfoWithRetry({ type: "allMids" }, opts);
  return { mids: normalizeAllMids(payload), updatedAt: Date.now() };
}

/**
 * Grid-aligned candle cache key: windows snap to timeframe boundaries, so
 * Scanner, Chart, Signal engine, Coin Analysis and History share ONE entry
 * per coin+timeframe+window instead of one per Date.now() call.
 */
export function candleCacheKey(
  symbol: string,
  timeframe: Timeframe,
  startTime: number,
  endTime: number,
): string {
  const grid = timeframeToMs(timeframe);
  const s = Math.floor(startTime / grid) * grid;
  const e = Math.ceil(endTime / grid) * grid;
  return `hl:candles:${symbol.toUpperCase()}:${timeframe}:${s}:${e}`;
}

/** Cached candle fetch used by charts (key includes window). */
export async function getCachedCandles(
  symbol: string,
  timeframe: Timeframe,
  startTime: number,
  endTime: number,
): Promise<{ candles: Candle[]; updatedAt: number }> {
  const key = candleCacheKey(symbol, timeframe, startTime, endTime);
  return cached(key, CACHE_TTL.candlesMs, async () => ({
    candles: await getCandles(symbol, timeframe, startTime, endTime),
    updatedAt: Date.now(),
  }));
}
