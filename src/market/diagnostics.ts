/**
 * Development diagnostics: lightweight counters for Hyperliquid traffic.
 * Pure module (no imports from the market layer → no cycles). The panel
 * renders in dev builds only; production users never see it.
 */

interface Counters {
  restRequests: number;
  restTimestamps: number[];
  wsConnections: number;
  wsPeakConnections: number;
  cacheHits: number;
  cacheMisses: number;
  rateLimits: number;
  activeSubscriptions: number;
}

const counters: Counters = {
  restRequests: 0,
  restTimestamps: [],
  wsConnections: 0,
  wsPeakConnections: 0,
  cacheHits: 0,
  cacheMisses: 0,
  rateLimits: 0,
  activeSubscriptions: 0,
};

const ONE_MINUTE = 60_000;
const MAX_TIMESTAMPS = 5000;

export function recordRestRequest(now = Date.now()): void {
  counters.restRequests += 1;
  counters.restTimestamps.push(now);
  if (counters.restTimestamps.length > MAX_TIMESTAMPS) {
    counters.restTimestamps.splice(0, counters.restTimestamps.length - MAX_TIMESTAMPS);
  }
}

export function recordRateLimit(): void {
  counters.rateLimits += 1;
}

export function recordCacheHit(): void {
  counters.cacheHits += 1;
}

export function recordCacheMiss(): void {
  counters.cacheMisses += 1;
}

export function setWsConnections(n: number): void {
  counters.wsConnections = n;
  counters.wsPeakConnections = Math.max(counters.wsPeakConnections, n);
}

export function setActiveSubscriptions(n: number): void {
  counters.activeSubscriptions = n;
}

export interface DiagnosticsSnapshot {
  restRequests: number;
  restPerMinute: number;
  wsConnections: number;
  wsPeakConnections: number;
  cacheHits: number;
  cacheMisses: number;
  cacheHitRate: number;
  rateLimits: number;
  activeSubscriptions: number;
}

export function readDiagnostics(now = Date.now()): DiagnosticsSnapshot {
  const recent = counters.restTimestamps.filter((t) => now - t < ONE_MINUTE).length;
  const totalCache = counters.cacheHits + counters.cacheMisses;
  return {
    restRequests: counters.restRequests,
    restPerMinute: recent,
    wsConnections: counters.wsConnections,
    wsPeakConnections: counters.wsPeakConnections,
    cacheHits: counters.cacheHits,
    cacheMisses: counters.cacheMisses,
    cacheHitRate: totalCache > 0 ? Math.round((counters.cacheHits / totalCache) * 100) : 0,
    rateLimits: counters.rateLimits,
    activeSubscriptions: counters.activeSubscriptions,
  };
}

export function resetDiagnosticsForTests(): void {
  counters.restRequests = 0;
  counters.restTimestamps = [];
  counters.wsConnections = 0;
  counters.wsPeakConnections = 0;
  counters.cacheHits = 0;
  counters.cacheMisses = 0;
  counters.rateLimits = 0;
  counters.activeSubscriptions = 0;
}
