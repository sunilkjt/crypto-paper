/**
 * Coin watchlist: persisted add/remove. The monitor prioritizes watched
 * coins (flagged on events, surfaced first) and can restrict alerts to
 * them — the global scanner keeps working regardless.
 */

const WATCHLIST_KEY = "cryptoin:watchlist:v1";
const MAX_WATCHED = 50;

function storage(): Storage | null {
  if (overrideForTests) return overrideForTests;
  try {
    if (typeof localStorage !== "undefined") return localStorage;
  } catch {
    // ignore
  }
  return null;
}

let overrideForTests: Storage | null = null;

/** Test seam: inject an in-memory Storage-like object. */
export function __setWatchlistStorageForTests(s: Storage | null): void {
  overrideForTests = s;
}

export function loadWatchlist(): string[] {
  const s = storage();
  if (!s) return [];
  try {
    const raw = s.getItem(WATCHLIST_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter((x): x is string => typeof x === "string").map((x) => x.toUpperCase()))].slice(0, MAX_WATCHED);
  } catch {
    return [];
  }
}

export function saveWatchlist(symbols: string[]): string[] {
  const clean = [...new Set(symbols.map((s) => s.toUpperCase().trim()).filter(Boolean))].slice(0, MAX_WATCHED);
  try {
    storage()?.setItem(WATCHLIST_KEY, JSON.stringify(clean));
  } catch {
    // best effort
  }
  return clean;
}

export function addWatched(symbol: string): string[] {
  const coin = symbol.toUpperCase().trim();
  if (!coin) return loadWatchlist();
  return saveWatchlist([coin, ...loadWatchlist()]);
}

export function removeWatched(symbol: string): string[] {
  return saveWatchlist(loadWatchlist().filter((s) => s !== symbol.toUpperCase()));
}

export function isWatched(symbol: string, list?: string[]): boolean {
  const watch = list ?? loadWatchlist();
  return watch.includes(symbol.toUpperCase());
}
