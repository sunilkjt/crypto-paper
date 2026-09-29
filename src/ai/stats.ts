/**
 * Dev-only AI usage counters (requests, cache hits/misses). Read by the
 * diagnostics panel; production users never see them. No PII, just counts.
 */

let calls = 0;
let hits = 0;
let misses = 0;

export function recordAiCall(): void {
  calls += 1;
}

export function recordAiCacheHit(): void {
  hits += 1;
}

export function recordAiCacheMiss(): void {
  misses += 1;
}

export interface AiStatsSnapshot {
  calls: number;
  hits: number;
  misses: number;
}

export function readAiStats(): AiStatsSnapshot {
  return { calls, hits, misses };
}

/** Test seam. */
export function resetAiStatsForTests(): void {
  calls = 0;
  hits = 0;
  misses = 0;
}
