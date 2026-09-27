import type { Signal } from "../analysis/signal";
import type { SetupType } from "../signals/setupType";

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
  /** TP1/TP2/TP3/entry/invalidation for TARGET_REACHED/ENTRY_REACHED. */
  detail: string | null;
  status: AlertStatus;
  timestamp: number;
  signal: Signal;
  watched: boolean;
  read: boolean;
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

export function eventMessage(e: Pick<SignalEvent, "type" | "symbol" | "direction" | "currentStrength" | "detail">): string {
  switch (e.type) {
    case "NEW_SIGNAL":
      return `NEW ${e.symbol} ${e.direction} — strength ${e.currentStrength}.`;
    case "SIGNAL_STRENGTHENED":
      return `${e.symbol} ${e.direction} strengthened to ${e.currentStrength}.`;
    case "SIGNAL_WEAKENED":
      return `${e.symbol} ${e.direction} weakened to ${e.currentStrength}.`;
    case "SIGNAL_INVALIDATED":
      return `${e.symbol} ${e.direction} invalidated.`;
    case "TARGET_REACHED":
      return `${e.symbol} ${e.direction} reached ${e.detail ?? "target"}.`;
    case "ENTRY_REACHED":
      return `${e.symbol} ${e.direction} reached entry zone.`;
    case "BOUNCE_DETECTED":
      return `Bounce setup: ${e.symbol} ${e.direction} — strength ${e.currentStrength}.`;
    case "BREAKOUT_DETECTED":
      return `Breakout setup: ${e.symbol} ${e.direction} — strength ${e.currentStrength}.`;
  }
}
