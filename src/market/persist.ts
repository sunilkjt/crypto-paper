import type { Market } from "./hyperliquid/types";

/**
 * Offline persistence for the last good markets snapshot.
 * localStorage only — instant (stale-flagged) paint on reload / offline,
 * then the live fetch replaces it. Corrupt or ancient snapshots are discarded.
 */

export const SNAPSHOT_KEY = "cryptoin:hl-markets-snapshot:v1";
export const SNAPSHOT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface MarketsSnapshot {
  markets: Market[];
  updatedAt: number;
}

export interface SnapshotStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function defaultStorage(): SnapshotStorage | null {
  try {
    if (typeof localStorage !== "undefined") return localStorage;
  } catch {
    // SSR / private-mode access can throw — treat as unavailable.
  }
  return null;
}

function isValidMarket(m: unknown): m is Market {
  if (typeof m !== "object" || m === null) return false;
  const r = m as Record<string, unknown>;
  if (typeof r.symbol !== "string" || r.symbol.length === 0) return false;
  for (const k of [
    "markPrice",
    "oraclePrice",
    "dayVolumeNotional",
    "dayChangePct",
    "fundingRate",
    "openInterestCoins",
    "openInterestNotional",
    "prevDayPrice",
    "midPrice",
  ]) {
    const v = r[k];
    if (v !== null && typeof v !== "number") return false;
  }
  return true;
}

export function decodeSnapshot(raw: string | null, now = Date.now()): MarketsSnapshot | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { markets?: unknown; updatedAt?: unknown };
    if (!Array.isArray(parsed.markets) || typeof parsed.updatedAt !== "number") return null;
    if (parsed.markets.length === 0 || parsed.markets.length > 2000) return null;
    if (!Number.isFinite(parsed.updatedAt) || now - parsed.updatedAt > SNAPSHOT_MAX_AGE_MS) {
      return null;
    }
    const markets = parsed.markets.filter(isValidMarket);
    if (markets.length === 0) return null;
    return { markets, updatedAt: parsed.updatedAt };
  } catch {
    return null;
  }
}

export function encodeSnapshot(snap: MarketsSnapshot): string {
  return JSON.stringify({ markets: snap.markets, updatedAt: snap.updatedAt });
}

export function loadMarketsSnapshot(
  storage: SnapshotStorage | null = defaultStorage(),
  now = Date.now(),
): MarketsSnapshot | null {
  if (!storage) return null;
  try {
    return decodeSnapshot(storage.getItem(SNAPSHOT_KEY), now);
  } catch {
    return null;
  }
}

export function saveMarketsSnapshot(
  snap: MarketsSnapshot,
  storage: SnapshotStorage | null = defaultStorage(),
): void {
  if (!storage || snap.markets.length === 0) return;
  try {
    storage.setItem(SNAPSHOT_KEY, encodeSnapshot(snap));
  } catch {
    // Quota / private mode — persistence is best-effort only.
  }
}

export function clearMarketsSnapshot(
  storage: SnapshotStorage | null = defaultStorage(),
): void {
  if (!storage) return;
  try {
    storage.removeItem(SNAPSHOT_KEY);
  } catch {
    // ignore
  }
}
