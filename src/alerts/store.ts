import { emitNotification } from "../signals/notifications";
import { eventMessage, resolveEventCategory, type AlertStatus, type SignalEvent } from "./events";
import { fingerprintOf, markNotified, shouldDeliver } from "./cooldown";
import { loadAlertSettings } from "./settings";
import type { MarketClass } from "../market/classify";
import type { NotificationProvider } from "./providers";

/**
 * Alert store: persisted event history (cap 200), NEW/ACTIVE/READ states,
 * coin/direction/event/date filters, and fan-out to notification providers
 * (browser/sound/telegram) plus the legacy in-app bus. Dedupe by stable
 * event ID — repeats update nothing and notify no one.
 */

const ALERTS_KEY = "cryptoin:alert-events:v1";
const MAX_EVENTS = 200;

function storage(): Storage | null {
  try {
    if (typeof localStorage !== "undefined") return localStorage;
  } catch {
    // ignore
  }
  return null;
}

export interface AlertFilters {
  coin: string; // "ALL" or symbol
  direction: "ALL" | "LONG" | "SHORT";
  event: "ALL" | SignalEvent["type"];
  /** Omitted (legacy callers) behaves as "ALL". */
  category?: "ALL" | MarketClass;
  sinceMs: number | null;
}

export const EMPTY_ALERT_FILTERS: AlertFilters = {
  coin: "ALL",
  direction: "ALL",
  event: "ALL",
  category: "ALL",
  sinceMs: null,
};

type Listener = (events: SignalEvent[]) => void;

const listeners = new Set<Listener>();
let providers: NotificationProvider[] = [];
let cache: SignalEvent[] | null = null;

function read(): SignalEvent[] {
  if (cache) return cache;
  const s = storage();
  if (!s) {
    cache = [];
    return cache;
  }
  try {
    const raw = s.getItem(ALERTS_KEY);
    if (!raw) {
      cache = [];
      return cache;
    }
    const parsed = JSON.parse(raw) as unknown;
    cache = Array.isArray(parsed) ? (parsed as SignalEvent[]).filter((e) => typeof e?.id === "string") : [];
    return cache;
  } catch {
    cache = [];
    return cache;
  }
}

function write(events: SignalEvent[]): void {
  cache = events.slice(0, MAX_EVENTS);
  try {
    storage()?.setItem(ALERTS_KEY, JSON.stringify(cache));
  } catch {
    // best effort
  }
  for (const l of listeners) {
    try {
      l(cache);
    } catch {
      // ignore
    }
  }
}

export function setAlertProviders(next: NotificationProvider[]): void {
  providers = next;
}

export function subscribeAlerts(listener: Listener): () => void {
  listeners.add(listener);
  listener(read());
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Ingest events: new IDs append (status NEW), activate on strengthen,
 * fan out to providers + legacy bus. Returns the newly added events.
 */
export function ingestAlertEvents(incoming: SignalEvent[]): SignalEvent[] {
  const current = read();
  const known = new Set(current.map((e) => e.id));
  // Dedupe both against history AND within the incoming batch.
  const fresh: SignalEvent[] = [];
  for (const e of incoming) {
    if (known.has(e.id)) continue;
    known.add(e.id);
    fresh.push(e);
  }
  if (fresh.length === 0) return [];
  // Repeat sightings of a live signal flip NEW → ACTIVE (no duplicate).
  const merged = [...fresh, ...current];
  for (const e of merged) {
    if (e.status === "NEW" && fresh.every((f) => f.id !== e.id)) {
      e.status = "ACTIVE";
    }
  }
  write(merged);
  // Delivery-only cooldown: history + in-app state record everything, but
  // browser/sound/telegram fire only for facts outside the suppression
  // window. Settings are read once per batch.
  const cooldownMs = loadAlertSettings().cooldownMs;
  const now = Date.now();
  for (const e of fresh) {
    const fp = fingerprintOf({
      type: e.type,
      category: resolveEventCategory(e),
      symbol: e.symbol,
      direction: e.direction,
      timeframe: e.timeframe,
      entryLow: e.signal.entryLow,
      entryHigh: e.signal.entryHigh,
      strength: e.currentStrength,
    });
    if (!shouldDeliver(fp, now, cooldownMs)) continue;
    markNotified(fp, now);
    for (const p of providers) {
      try {
        if (p.isAvailable()) p.notify(e);
      } catch {
        // provider errors never break ingestion
      }
    }
    try {
      emitNotification({
        kind: e.type === "NEW_SIGNAL" || e.type === "BOUNCE_DETECTED" || e.type === "BREAKOUT_DETECTED" ? "NEW_SETUP" : "STATE_CHANGE",
        symbol: e.symbol,
        direction: e.direction,
        strength: e.currentStrength,
        message: eventMessage(e),
      });
    } catch {
      // ignore
    }
  }
  return fresh;
}

export function markAlertRead(id: string): void {
  write(read().map((e) => (e.id === id ? { ...e, read: true, status: "READ" as AlertStatus } : e)));
}

export function markAllAlertsRead(): void {
  write(read().map((e) => ({ ...e, read: true, status: "READ" as AlertStatus })));
}

export function clearAlertHistory(): void {
  write([]);
}

export function filterAlerts(events: SignalEvent[], f: AlertFilters): SignalEvent[] {
  return events.filter(
    (e) =>
      (f.coin === "ALL" || e.symbol === f.coin) &&
      (f.direction === "ALL" || e.direction === f.direction) &&
      (f.event === "ALL" || e.type === f.event) &&
      ((f.category ?? "ALL") === "ALL" || resolveEventCategory(e) === f.category) &&
      (f.sinceMs === null || e.timestamp >= f.sinceMs),
  );
}

export function alertStatusCounts(events: SignalEvent[]): Record<AlertStatus, number> {
  const out: Record<AlertStatus, number> = { NEW: 0, ACTIVE: 0, READ: 0 };
  for (const e of events) out[e.status] = (out[e.status] ?? 0) + 1;
  return out;
}

export function resetAlertsForTests(): void {
  cache = null;
  listeners.clear();
  providers = [];
  try {
    storage()?.removeItem(ALERTS_KEY);
  } catch {
    // ignore
  }
}
