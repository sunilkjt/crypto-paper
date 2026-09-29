import type { AiAnalysis, AiAnalysisInput } from "./types";

/**
 * Cache key: symbol + setup timeframe + signal timestamp + data timestamp.
 * A new key is minted whenever the signal or the underlying data changes,
 * so refresh happens naturally; entries additionally expire by TTL.
 */
export function aiCacheKey(symbol: string, timeframe: string, signal: { timestamp: number; dataTimestamp: number }): string {
  return `ai:${symbol.toUpperCase()}:${timeframe}:${signal.timestamp}:${signal.dataTimestamp}`;
}

/**
 * Stable signal identity for cache/throttle/dedupe keys. Deliberately
 * EXCLUDES analysisTimestamp (minted fresh on every input build): keying on
 * it made every price tick look like a new signal, bypassing the cache and
 * hammering the backend into rate limits. Ticks share the key (cache hit, no
 * request); a new candle, direction, or strength mints a new key (refresh).
 */
export function aiSignalKey(input: AiAnalysisInput, timeframe: string): string {
  return `ai:${input.symbol.toUpperCase()}:${timeframe}:${input.signalDirection}:${input.signalStrength}:${input.marketDataTimestamp}`;
}

export const AI_CACHE_TTL_MS = 15 * 60 * 1000;

interface Entry {
  analysis: AiAnalysis;
  expiresAt: number;
}

const store = new Map<string, Entry>();

export function getCachedAi(key: string, input: AiAnalysisInput, now = Date.now()): AiAnalysis | null {
  const hit = store.get(key);
  if (!hit) return null;
  if (hit.expiresAt <= now) {
    store.delete(key);
    return null;
  }
  // Bind the cached text to the current data timestamp for honest display.
  if (hit.analysis.marketDataTimestamp !== input.marketDataTimestamp) return null;
  return hit.analysis;
}

export function setCachedAi(key: string, analysis: AiAnalysis, now = Date.now()): void {
  store.set(key, { analysis, expiresAt: now + AI_CACHE_TTL_MS });
  if (store.size > 100) {
    const oldest = store.keys().next();
    if (!oldest.done) store.delete(oldest.value);
  }
}

export function clearAiCache(): void {
  store.clear();
}
