/**
 * Lightweight in-memory cache: dedupes concurrent requests,
 * expires stale entries, evicts on capacity. No external DB.
 *
 * AUDIT NOTE — this layer ALREADY coalesced simultaneous duplicates, but
 * candle callers passed Date.now()-derived windows, so every call had a
 * unique key and nothing ever hit. Callers must use grid-aligned windows
 * (see candleCacheKey) for cross-component reuse: Scanner → Chart →
 * Signal engine → Coin Analysis → History all share one entry.
 */

import { recordCacheHit, recordCacheMiss } from "./diagnostics";

interface Entry<T> {
  value: T;
  expiresAt: number;
  promise?: undefined;
}

interface Pending<T> {
  promise: Promise<T>;
  expiresAt: number;
}

const store = new Map<string, Entry<unknown> | Pending<unknown>>();
const MAX_ENTRIES = 200;

function evictIfNeeded(): void {
  if (store.size <= MAX_ENTRIES) return;
  const oldest = store.keys().next();
  if (!oldest.done) store.delete(oldest.value);
}

/**
 * Get-or-fetch with TTL + concurrent-request coalescing.
 * On fetch failure, a previous fresh-enough value is NOT served here
 * (callers decide fallback); the pending slot is cleared so retries work.
 */
export async function cached<T>(
  key: string,
  ttlMs: number,
  fetcher: () => Promise<T>,
): Promise<T> {
  const now = Date.now();
  if (ttlMs <= 0) {
    // Non-positive TTL means bypass: always refetch, never serve stale.
    const value = await fetcher();
    return value;
  }
  const hit = store.get(key);
  if (hit && "value" in hit && hit.expiresAt > now) {
    recordCacheHit();
    return hit.value as T;
  }
  if (hit && "promise" in hit && hit.expiresAt > now) {
    recordCacheHit();
    return hit.promise as Promise<T>;
  }
  recordCacheMiss();

  const promise = fetcher()
    .then((value) => {
      store.set(key, { value, expiresAt: Date.now() + ttlMs });
      evictIfNeeded();
      return value;
    })
    .catch((err) => {
      // Clear the pending slot so the next call retries.
      if (store.get(key) !== undefined) {
        const current = store.get(key);
        if (current && "promise" in current) store.delete(key);
      }
      throw err;
    });

  store.set(key, { promise, expiresAt: now + ttlMs });
  evictIfNeeded();
  return promise;
}

export function invalidate(key: string): void {
  store.delete(key);
}

export function clearCache(): void {
  store.clear();
}

export const CACHE_TTL = {
  // Snapshot polls run every 30s; 45s TTL keeps them inside the 60s LIVE
  // window while cutting per-dex refetches by roughly a third.
  marketsMs: 45_000,
  // Candles refresh on 30–60s cadences; 30s TTL with grid-aligned keys
  // lets overlapping consumers share entries instead of refetching.
  candlesMs: 30_000,
} as const;
