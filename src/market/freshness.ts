/**
 * Central freshness utility. Single source of truth for LIVE vs DATA STALE.
 */

export const FRESHNESS = {
  /** Markets older than this are STALE (WS ticks normally keep them fresh). */
  marketsStaleAfterMs: 60_000,
  /** Candles older than this are STALE. */
  candlesStaleAfterMs: 90_000,
} as const;

export function ageMs(updatedAt: number, now = Date.now()): number {
  return Math.max(0, now - updatedAt);
}

export function isStale(updatedAt: number, thresholdMs: number, now = Date.now()): boolean {
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) return true;
  return now - updatedAt > thresholdMs;
}

export function isMarketsStale(updatedAt: number, now = Date.now()): boolean {
  return isStale(updatedAt, FRESHNESS.marketsStaleAfterMs, now);
}

export function formatLastUpdated(updatedAt: number, now = Date.now()): string {
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) return "Last updated: never";
  const s = Math.floor(ageMs(updatedAt, now) / 1000);
  if (s < 1) return "Last updated: just now";
  if (s === 1) return "Last updated: 1 second ago";
  if (s < 60) return `Last updated: ${s} seconds ago`;
  const m = Math.floor(s / 60);
  return m === 1 ? "Last updated: 1 minute ago" : `Last updated: ${m} minutes ago`;
}
