import type { AiAnalysis, AiAnalysisInput } from "./types";

/**
 * Cache key: symbol + setup timeframe + signal timestamp + data timestamp.
 * A new key is minted whenever the signal or the underlying data changes,
 * so refresh happens naturally; entries additionally expire by TTL.
 */
export function aiCacheKey(symbol: string, timeframe: string, signal: { timestamp: number; dataTimestamp: number }): string {
  return `ai:${symbol.toUpperCase()}:${timeframe}:${signal.timestamp}:${signal.dataTimestamp}`;
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
