import { wsManager } from "../ws";
import { onVisible, pollAllowed } from "../visibility";
import { getAllMids } from "./index";

/**
 * Canonical realtime entry point for market ticks.
 * WebSocket first (single shared socket via wsManager); when the socket
 * is quiet — blocked, failing, or unsupported in the browser — controlled
 * HTTPS polling takes over. Callers get ticks with their source and never
 * touch endpoints or sockets directly.
 */

export type TickSource = "ws" | "poll";

export interface RealtimeCallbacks {
  onTick: (mids: Record<string, number>, source: TickSource, at: number) => void;
  /** Polling fallback itself failed (counts toward DEGRADED/OFFLINE). */
  onPollError?: (message: string) => void;
}

const DEFAULT_POLL_MS = 15_000;

/**
 * Start the feed. Returns a cleanup function — call it on unmount.
 * Safe to call from multiple components: the socket stays singular,
 * each caller only adds/removes its own listener + fallback timer.
 */
export function startMarketRealtime(
  cb: RealtimeCallbacks,
  opts?: { pollMs?: number },
): () => void {
  const pollMs = opts?.pollMs ?? DEFAULT_POLL_MS;
  let stopped = false;
  let lastWsTick = 0;

  const unsub = wsManager.subscribeAllMids((mids) => {
    if (stopped) return;
    lastWsTick = Date.now();
    cb.onTick(mids, "ws", lastWsTick);
  });

  const timer = window.setInterval(async () => {
    if (stopped) return;
    // Hidden tabs skip polling; the socket keeps pushing either way.
    if (!pollAllowed()) return;
    if (Date.now() - lastWsTick < pollMs) return;
    try {
      const { mids, updatedAt } = await getAllMids();
      if (stopped) return;
      cb.onTick(mids, "poll", updatedAt);
    } catch (err) {
      if (stopped) return;
      cb.onPollError?.(
        err instanceof Error && err.message
          ? err.message
          : "Unable to retrieve Hyperliquid market data. Retrying…",
      );
    }
  }, pollMs);

  // Returning to the tab nudges one immediate freshness check.
  const offVisible = onVisible(() => {
    lastWsTick = 0;
  });

  return () => {
    stopped = true;
    window.clearInterval(timer);
    offVisible();
    unsub();
  };
}
