import type { Signal } from "../analysis/signal";
import type { SetupType } from "../signals/setupType";
import { CATEGORY_LABEL, type MarketClass } from "../market/classify";

/**
 * Signal events — the monitor's vocabulary. Stable IDs dedupe everything:
 * the same unchanged signal never re-alerts. Paper/live price evaluation
 * feeds TARGET_REACHED and ENTRY_REACHED; the scan feeds the rest.
 */

export type SignalEventType =
  | "NEW_SIGNAL"
  | "SIGNAL_STRENGTHENED"
  | "SIGNAL_WEAKENED"
  | "SIGNAL_INVALIDATED"
  | "TARGET_REACHED"
  | "ENTRY_REACHED"
  | "BOUNCE_DETECTED"
  | "BREAKOUT_DETECTED";

export type AlertStatus = "NEW" | "ACTIVE" | "READ";

export interface SignalEvent {
  /** Stable: signalId:eventType[:detail] — identical repeats collapse. */
  id: string;
  type: SignalEventType;
  symbol: string;
  direction: "LONG" | "SHORT";
  setupType: SetupType;
  timeframe: string;
  previousStrength: number | null;
  currentStrength: number;
  /** TP1/TP2/3/entry/invalidation for TARGET_REACHED/ENTRY_REACHED. */
  detail: string | null;
  status: AlertStatus;
  timestamp: number;
  signal: Signal;
  watched: boolean;
  read: boolean;
  /**
   * Market class at emission time. Optional so pre-feature stored events
   * stay readable — readers fall back to eventCategoryLabel().
   */
  category?: MarketClass;
}

/**
 * Resolved class for an event. Explicit category (set at emission with live
 * market data) wins; legacy stored events without one fall back to a neutral
 * rule that never silently claims CRYPTO for a dex-prefixed symbol.
 */
export function resolveEventCategory(e: Pick<SignalEvent, "symbol" | "category">): MarketClass {
  if (e.category) return e.category;
  return e.symbol.includes(":") ? "other" : "crypto";
}

/** Display label for an event's class (text, never color-only). */
export function eventCategoryLabel(e: Pick<SignalEvent, "symbol" | "category">): string {
  return CATEGORY_LABEL[resolveEventCategory(e)];
}

/** Stable event ID: repeats of the same fact share one ID. */
export function stableEventId(args: {
  signalId: string;
  type: SignalEventType;
  detail?: string | null;
}): string {
  const parts = [args.signalId, args.type];
  if (args.detail) parts.push(args.detail);
  return parts.join("::");
}

export function eventMessage(
  e: Pick<SignalEvent, "type" | "symbol" | "direction" | "currentStrength" | "detail"> & { category?: SignalEvent["category"] },
): string {
  const cat = eventCategoryLabel({ symbol: e.symbol, category: e.category });
  const head = `${cat} ${e.direction === "LONG" ? "📈" : "📉"}`;
  switch (e.type) {
    case "NEW_SIGNAL":
      return `${head} — NEW ${e.symbol} ${e.direction}, score ${e.currentStrength}.`;
    case "SIGNAL_STRENGTHENED":
      return `${head} — ${e.symbol} ${e.direction} strengthened to ${e.currentStrength}.`;
    case "SIGNAL_WEAKENED":
      return `${head} — ${e.symbol} ${e.direction} weakened to ${e.currentStrength}.`;
    case "SIGNAL_INVALIDATED":
      return `${head} — ${e.symbol} ${e.direction} invalidated.`;
    case "TARGET_REACHED":
      return `${head} — ${e.symbol} ${e.direction} reached ${e.detail ?? "target"}.`;
    case "ENTRY_REACHED":
      return `${head} — ${e.symbol} ${e.direction} reached entry zone.`;
    case "BOUNCE_DETECTED":
      return `${head} — bounce setup ${e.symbol} ${e.direction}, score ${e.currentStrength}.`;
    case "BREAKOUT_DETECTED":
      return `${head} — breakout setup ${e.symbol} ${e.direction}, score ${e.currentStrength}.`;
  }
}
