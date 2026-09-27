import type { SignalEvent } from "./events";

/**
 * Alert → coin navigation helpers. The project routes coin analysis at
 * `/coin/:symbol` (HashRouter), where `:symbol` is the Hyperliquid coin
 * name (BTC, ETH, OP, xyz:XYZ100, …) — no suffixes, no new routes.
 */

export interface AlertNavigation {
  /** Router path, e.g. "/coin/OP". Null when the alert is not navigable. */
  path: string | null;
  /** Router state carrying the alert context for the destination banner. */
  state: {
    fromAlert: {
      id: string;
      type: SignalEvent["type"];
      direction: SignalEvent["direction"];
      strength: number;
      timestamp: number;
    };
  } | null;
}

/** A symbol navigates only when it is a non-empty coin name. */
export function isNavigableSymbol(symbol: unknown): symbol is string {
  return typeof symbol === "string" && symbol.trim().length > 0 && symbol.trim().length <= 32;
}

/** An alert navigates only when its market reference is intact. */
export function isNavigableAlert(event: Pick<SignalEvent, "symbol"> | null | undefined): boolean {
  if (!event) return false;
  return isNavigableSymbol(event.symbol);
}

/**
 * Build the coin-analysis destination for an alert. Returns path null for
 * missing/blank symbols so callers render a non-clickable graceful row.
 * Symbol case is preserved as-is (CoinAnalysis normalizes); surrounding
 * whitespace is trimmed.
 */
export function alertCoinNavigation(event: SignalEvent): AlertNavigation {
  if (!isNavigableAlert(event)) return { path: null, state: null };
  const symbol = event.symbol.trim();
  return {
    path: `/coin/${symbol}`,
    state: {
      fromAlert: {
        id: event.id,
        type: event.type,
        direction: event.direction,
        strength: event.currentStrength,
        timestamp: event.timestamp,
      },
    },
  };
}
