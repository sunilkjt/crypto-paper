import type { ScannedCoin } from "../scanner/engine";
import { isListableBounce } from "../analysis/signal";
import { checkTargets } from "./targets";
import { stableEventId, type SignalEvent, type SignalEventType } from "./events";
import { passesAlertFilters, type AlertSettings } from "./settings";

/**
 * Pure scan evaluation: previous snapshot + fresh results + marks →
 * dedupe-safe SignalEvents. The caller persists/ingests; this function
 * never touches storage, network, or providers (fully unit-testable).
 * AI and news are never consulted — alerts are engine-only by design.
 */

export interface MonitorSnapshot {
  strength: number;
  status: string;
}

export interface MonitorContext {
  marks: Map<string, number | null>;
  watchlist: string[];
  settings: AlertSettings;
  now?: number;
}

function baseEvent(
  r: ScannedCoin,
  type: SignalEventType,
  ctx: MonitorContext,
  previousStrength: number | null,
  detail: string | null,
): SignalEvent | null {
  if (!r.id || r.signal.direction === "WAIT") return null;
  const watched = ctx.watchlist.includes(r.symbol);
  const candidate = {
    strength: r.signal.signalStrength,
    direction: r.signal.direction,
    setupType: r.setupType,
    timeframe: r.signal.timeframe,
    watched,
  };
  if (!passesAlertFilters(candidate, ctx.settings)) return null;
  return {
    id: stableEventId({ signalId: r.id, type, detail }),
    type,
    symbol: r.symbol,
    direction: r.signal.direction,
    setupType: r.setupType,
    timeframe: r.signal.timeframe,
    previousStrength,
    currentStrength: r.signal.signalStrength,
    detail,
    status: "NEW",
    timestamp: ctx.now ?? Date.now(),
    signal: r.signal,
    watched,
    read: false,
  };
}

/**
 * Diff one scan against the previous snapshot. Emits NEW (or the specific
 * BOUNCE/BREAKOUT variant), STRENGTHENED/WEAKENED on ±5 moves, and
 * INVALIDATED when the lifecycle turned. One event per fact — repeats
 * share stable IDs downstream.
 */
export function evaluateScan(
  prev: Map<string, MonitorSnapshot>,
  results: ScannedCoin[],
  lifecycleById: Map<string, string>,
  ctx: MonitorContext,
): SignalEvent[] {
  const events: SignalEvent[] = [];
  for (const r of results) {
    if (!r.id || r.signal.direction === "WAIT") continue;
    const before = prev.get(r.id);
    if (!before) {
      const kind: SignalEventType =
        r.setupType === "BOUNCE" && isListableBounce(r.signal)
          ? "BOUNCE_DETECTED"
          : r.setupType === "BREAKOUT" || r.setupType === "BREAKDOWN"
            ? "BREAKOUT_DETECTED"
            : "NEW_SIGNAL";
      const e = baseEvent(r, kind, ctx, null, null);
      if (e) events.push(e);
      continue;
    }
    const lifecycle = lifecycleById.get(r.id);
    if (lifecycle === "INVALIDATED") {
      const e = baseEvent(r, "SIGNAL_INVALIDATED", ctx, before.strength, "invalidation");
      if (e) events.push(e);
      continue;
    }
    if (lifecycle === "STRENGTHENING") {
      const e = baseEvent(r, "SIGNAL_STRENGTHENED", ctx, before.strength, null);
      if (e) events.push(e);
    } else if (lifecycle === "WEAKENING") {
      const e = baseEvent(r, "SIGNAL_WEAKENED", ctx, before.strength, null);
      if (e) events.push(e);
    }
  }
  return events;
}

/**
 * Target touches on live marks for actively tracked setups.
 * Each level fires once per signal ID (stable detail IDs).
 */
export function evaluateTargets(
  results: ScannedCoin[],
  marks: Map<string, number | null>,
  ctx: MonitorContext,
): SignalEvent[] {
  const events: SignalEvent[] = [];
  for (const r of results) {
    if (!r.id || r.signal.direction === "WAIT") continue;
    const mark = marks.get(r.symbol);
    if (mark === null || mark === undefined) continue;
    const touched = checkTargets(r.signal, mark);
    for (const level of touched) {
      const type = level === "ENTRY" ? "ENTRY_REACHED" : level === "INVALIDATION" ? "SIGNAL_INVALIDATED" : "TARGET_REACHED";
      const e = baseEvent(r, type, ctx, null, level);
      if (e) events.push(e);
    }
  }
  return events;
}
