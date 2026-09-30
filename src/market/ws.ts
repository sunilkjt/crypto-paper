import { WS_URL } from "./hyperliquid/client";
import { normalizeAllMids } from "./hyperliquid/markets";
import { coinForRequest, normalizeWsCandle } from "./hyperliquid/candles";
import type { Candle, RawWsCandle } from "./hyperliquid/types";
import { setActiveSubscriptions, setWsConnections } from "./diagnostics";

/**
 * Singleton WebSocket manager.
 * - ONE shared connection for the whole app (never per coin/component).
 * - Multiplexes: allMids broadcast + per-coin candle subscriptions.
 * - Exponential-backoff reconnect, heartbeat timeout, clean unsubscribe.
 * - Page navigation only adds/removes listeners; the socket persists and
 *   closes itself when the last listener unsubscribes (see maybeIdleClose).
 */

type AllMidsListener = (mids: Record<string, number>) => void;
type CandleListener = (candle: Candle) => void;

interface CandleSub {
  coin: string;
  interval: string;
  listeners: Set<CandleListener>;
}

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const HEARTBEAT_TIMEOUT_MS = 45_000;

class WsManager {
  private ws: WebSocket | null = null;
  private allMidsListeners = new Set<AllMidsListener>();
  private candleSubs = new Map<string, CandleSub>(); // key: COIN:interval
  private reconnectAttempts = 0;
  private reconnectTimer: number | null = null;
  private heartbeatTimer: number | null = null;
  private explicitlyClosed = false;
  private connectPromise: Promise<void> | null = null;

  get connectionCount(): number {
    return this.ws && this.ws.readyState === WebSocket.OPEN ? 1 : 0;
  }

  /** Coarse socket state for status UI: open | connecting | idle. */
  get connectionState(): "open" | "connecting" | "idle" {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return "open";
    if (this.connectPromise !== null || this.reconnectTimer !== null) return "connecting";
    return "idle";
  }

  private reportDiagnostics(): void {
    try {
      setWsConnections(this.connectionCount);
      let subs = this.allMidsListeners.size;
      for (const sub of this.candleSubs.values()) subs += sub.listeners.size;
      setActiveSubscriptions(subs);
    } catch {
      // diagnostics must never break the socket
    }
  }

  subscribeAllMids(listener: AllMidsListener): () => void {
    this.allMidsListeners.add(listener);
    this.reportDiagnostics();
    this.ensureConnection().catch(() => {
      // Connection errors surface via onStatus callbacks / polling fallback.
    });
    return () => {
      this.allMidsListeners.delete(listener);
      this.reportDiagnostics();
      this.maybeIdleClose();
    };
  }

  subscribeCandles(coin: string, interval: string, listener: CandleListener): () => void {
    const canonical = coinForRequest(coin);
    const key = `${canonical}:${interval}`;
    let sub = this.candleSubs.get(key);
    if (!sub) {
      sub = { coin: canonical, interval, listeners: new Set() };
      this.candleSubs.set(key, sub);
    }
    sub.listeners.add(listener);
    this.reportDiagnostics();
    // Send immediately only on a live socket; otherwise the (re)connect
    // handler below replays every active subscription exactly once.
    // (Sending in both places used to duplicate every candle sub.)
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.sendSubscribe({ type: "candle", coin: sub.coin, interval: sub.interval });
    } else {
      this.ensureConnection().catch(() => undefined);
    }
    return () => {
      const s = this.candleSubs.get(key);
      if (!s) return;
      s.listeners.delete(listener);
      if (s.listeners.size === 0) {
        this.candleSubs.delete(key);
        this.sendUnsubscribe({ type: "candle", coin: s.coin, interval: s.interval });
      }
      this.reportDiagnostics();
      this.maybeIdleClose();
    };
  }

  closeAll(): void {
    this.explicitlyClosed = true;
    this.clearTimers();
    try {
      this.ws?.close();
    } catch {
      // ignore
    }
    this.ws = null;
    this.connectPromise = null;
  }

  private ensureConnection(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return Promise.resolve();
    if (this.connectPromise) return this.connectPromise;
    this.explicitlyClosed = false;
    this.connectPromise = new Promise<void>((resolve, reject) => {
      let settled = false;
      try {
        const ws = new WebSocket(WS_URL);
        this.ws = ws;

        const cleanup = () => {
          ws.onopen = null;
          ws.onmessage = null;
          ws.onerror = null;
          ws.onclose = null;
        };

        ws.onopen = () => {
          settled = true;
          this.reconnectAttempts = 0;
          this.armHeartbeat();
          this.reportDiagnostics();
          // (Re)send every active subscription on (re)connect.
          this.sendSubscribe({ type: "allMids" });
          for (const sub of this.candleSubs.values()) {
            this.sendSubscribe({ type: "candle", coin: sub.coin, interval: sub.interval });
          }
          resolve();
        };
        ws.onmessage = (ev) => this.handleMessage(ev);
        ws.onerror = () => {
          if (!settled) {
            settled = true;
            cleanup();
            reject(new Error("Hyperliquid WebSocket connection failed."));
          }
        };
        ws.onclose = () => {
          cleanup();
          this.ws = null;
          this.connectPromise = null;
          this.reportDiagnostics();
          if (!settled) {
            settled = true;
            reject(new Error("Hyperliquid WebSocket closed before open."));
          }
          this.scheduleReconnect();
        };
      } catch (err) {
        this.connectPromise = null;
        reject(err instanceof Error ? err : new Error("WebSocket unavailable."));
      }
    });
    return this.connectPromise;
  }

  private sendSubscribe(sub: Record<string, unknown>): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ method: "subscribe", subscription: sub }));
    }
  }

  private sendUnsubscribe(sub: Record<string, unknown>): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ method: "unsubscribe", subscription: sub }));
    }
  }

  private handleMessage(ev: MessageEvent): void {
    this.armHeartbeat();
    let msg: { channel?: string; data?: unknown };
    try {
      msg = JSON.parse(String(ev.data)) as { channel?: string; data?: unknown };
    } catch {
      return;
    }
    if (msg.channel === "allMids") {
      try {
        // WS shape: { mids: Record<string,string> }
        const raw = (msg.data as { mids?: unknown })?.mids ?? msg.data;
        const mids = normalizeAllMids(raw);
        for (const l of this.allMidsListeners) {
          try {
            l(mids);
          } catch {
            // Listener errors must not kill the socket loop.
          }
        }
      } catch {
        // Malformed tick — ignore, polling fallback covers it.
      }
      return;
    }
    if (msg.channel === "candle") {
      const arr = Array.isArray(msg.data) ? (msg.data as RawWsCandle[]) : [];
      for (const raw of arr) {
        try {
          const candle = normalizeWsCandle(raw);
          const key = `${coinForRequest(String(raw.s))}:${String(raw.i)}`;
          const sub = this.candleSubs.get(key);
          if (!sub) continue;
          for (const l of sub.listeners) {
            try {
              l(candle);
            } catch {
              // ignore listener errors
            }
          }
        } catch {
          continue;
        }
      }
    }
  }

  private armHeartbeat(): void {
    if (this.heartbeatTimer !== null) window.clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = window.setTimeout(() => {
      // No traffic for a while: force reconnect.
      try {
        this.ws?.close();
      } catch {
        // ignore
      }
    }, HEARTBEAT_TIMEOUT_MS);
  }

  private scheduleReconnect(): void {
    if (this.explicitlyClosed) return;
    if (this.allMidsListeners.size === 0 && this.candleSubs.size === 0) return;
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.reconnectAttempts, RECONNECT_MAX_MS);
    this.reconnectAttempts += 1;
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = window.setTimeout(() => {
      this.connectPromise = null;
      this.ensureConnection().catch(() => {
        // Will retry via onclose path.
      });
    }, delay);
  }

  private maybeIdleClose(): void {
    if (this.allMidsListeners.size === 0 && this.candleSubs.size === 0) {
      this.clearTimers();
      try {
        this.ws?.close();
      } catch {
        // ignore
      }
      this.ws = null;
      this.connectPromise = null;
    }
  }

  private clearTimers(): void {
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    if (this.heartbeatTimer !== null) window.clearTimeout(this.heartbeatTimer);
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
  }
}

export const wsManager = new WsManager();
