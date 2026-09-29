import type { MarketClass } from "../market/classify";

/**
 * Notification fingerprint + cooldown gate (delivery only — history is
 * untouched). A fingerprint identifies one notifiable fact:
 *
 *   TYPE:category:symbol:direction:timeframe:entryZone:scoreBucket
 *
 * - Repeats of the same fact (LONG → LONG) share the fingerprint and are
 *   suppressed inside the cooldown window (default 30 min, configurable).
 * - State changes mint new fingerprints (direction flip, new TF, new entry
 *   zone, new score bucket, or a different event type such as INVALIDATED)
 *   and always notify.
 * - Category is part of the key: stocks:AAPL and commodities:AAPL can never
 *   collide even if one symbol ever existed in both classes.
 * - Type is part of the key so a terminal INVALIDATED is never swallowed by
 *   the NEW_SIGNAL that preceded it.
 */

export interface NotifyFingerprintInput {
  type: string;
  category: MarketClass;
  symbol: string;
  direction: string;
  timeframe: string;
  entryLow: number | null;
  entryHigh: number | null;
  strength: number;
}

/** Score bucket of 5: 82 and 83 share a fingerprint; 86 does not. */
export function scoreBucket(strength: number): number {
  if (!Number.isFinite(strength)) return 0;
  return Math.floor(strength / 5) * 5;
}

export function fingerprintOf(f: NotifyFingerprintInput): string {
  const zone = `${f.entryLow ?? "—"}-${f.entryHigh ?? "—"}`;
  return [f.type, f.category, f.symbol.toUpperCase(), f.direction, f.timeframe, zone, scoreBucket(f.strength)].join(":");
}

/** Pure time check: no record, disabled cooldown (<=0), or window elapsed. */
export function isOutsideCooldown(
  lastNotifiedAt: number | undefined,
  now: number,
  cooldownMs: number,
): boolean {
  if (cooldownMs <= 0) return true;
  if (lastNotifiedAt === undefined) return true;
  return now - lastNotifiedAt >= cooldownMs;
}

const COOLDOWN_KEY = "cryptoin:notify-cooldown:v1";
const MAX_KEYS = 300;

let overrideForTests: Storage | null | undefined;

function storage(): Storage | null {
  if (overrideForTests !== undefined) return overrideForTests;
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    return null;
  }
}

/** Test seam: inject an in-memory Storage-like object. */
export function __setCooldownStorageForTests(s: Storage | null): void {
  overrideForTests = s;
}

function readMap(): Record<string, number> {
  try {
    const raw = storage()?.getItem(COOLDOWN_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function writeMap(map: Record<string, number>): void {
  try {
    const keys = Object.keys(map);
    const trimmed: Record<string, number> = {};
    for (const k of keys.slice(-MAX_KEYS)) trimmed[k] = map[k];
    storage()?.setItem(COOLDOWN_KEY, JSON.stringify(trimmed));
  } catch {
    // best effort
  }
}

export function getLastNotified(fingerprint: string): number | undefined {
  return readMap()[fingerprint];
}

export function markNotified(fingerprint: string, now: number = Date.now()): void {
  const map = readMap();
  map[fingerprint] = now;
  writeMap(map);
}

/** Delivery gate: true unless this exact fact was already sent in-window. */
export function shouldDeliver(fingerprint: string, now: number, cooldownMs: number): boolean {
  const s = storage();
  if (!s) return true; // no persistence available — never suppress blindly
  return isOutsideCooldown(getLastNotified(fingerprint), now, cooldownMs);
}
