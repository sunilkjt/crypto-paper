import { useCallback, useEffect, useState } from "react";
import { getCandleWindow } from "./hyperliquid/timeframes";
import { coinForRequest } from "./hyperliquid/candles";
import { getCachedCandles } from "./hyperliquid";
import { wsManager } from "./ws";
import { onVisible, pollAllowed } from "./visibility";
import { isStale, FRESHNESS } from "./freshness";
import type { Candle, Timeframe } from "./hyperliquid/types";
import { HyperliquidError } from "./hyperliquid/types";

export interface CandlesState {
  candles: Candle[];
  status: "loading" | "live" | "stale" | "error";
  error: string | null;
  updatedAt: number;
  stale: boolean;
}

function toMessage(err: unknown): string {
  if (err instanceof HyperliquidError) return err.message;
  if (err instanceof Error && err.message) return err.message;
  return "Unable to retrieve Hyperliquid market data. Retrying…";
}

/**
 * Live candles for one coin+timeframe.
 * REST history first, then WS candle subscription merges the forming candle.
 * Polling fallback refreshes if WS goes quiet. No full-app reloads.
 */
export function useCandles(symbol: string, timeframe: Timeframe, limit = 300): CandlesState {
  const coin = coinForRequest(symbol);
  const [candles, setCandles] = useState<Candle[]>([]);
  const [status, setStatus] = useState<CandlesState["status"]>("loading");
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState(0);

  const refreshWindow = useCallback(async () => {
    try {
      const w = getCandleWindow(timeframe, Date.now(), limit);
      const { candles: fresh, updatedAt: ts } = await getCachedCandles(
        coin,
        timeframe,
        w.startTime,
        w.endTime,
      );
      setCandles(fresh);
      setUpdatedAt(ts);
      setStatus((s) => (s === "error" && fresh.length === 0 ? s : "live"));
    } catch {
      // Keep existing candles; error banner only when empty.
    }
  }, [coin, timeframe, limit]);

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    setError(null);
    setCandles([]);
    setUpdatedAt(0);

    const { startTime, endTime } = getCandleWindow(timeframe, Date.now(), limit);
    getCachedCandles(coin, timeframe, startTime, endTime)
      .then(({ candles: fresh, updatedAt: ts }) => {
        if (cancelled) return;
        setCandles(fresh);
        setUpdatedAt(ts);
        setStatus("live");
      })
      .catch((err) => {
        if (cancelled) return;
        setStatus("error");
        setError(toMessage(err));
      });

    // Live forming-candle updates over the single shared WS connection.
    const unsub = wsManager.subscribeCandles(coin, timeframe, (tick) => {
      setCandles((prev) => {
        if (prev.length === 0) return [tick];
        const last = prev[prev.length - 1];
        if (tick.timestamp === last.timestamp) {
          const next = prev.slice();
          next[next.length - 1] = tick;
          return next;
        }
        if (tick.timestamp > last.timestamp) {
          const next = [...prev, tick];
          return next.length > limit ? next.slice(next.length - limit) : next;
        }
        return prev;
      });
      setUpdatedAt(Date.now());
      setStatus("live");
      setError(null);
    });

    // Polling fallback every 30s keeps the chart alive without WS.
    // Hidden tabs skip it (WS ticks still merge); cleanup on unmount.
    const poll = window.setInterval(() => {
      if (pollAllowed()) void refreshWindow();
    }, 30_000);

    return () => {
      cancelled = true;
      unsub();
      window.clearInterval(poll);
    };
  }, [coin, timeframe, limit, refreshWindow]);

  // Returning to the tab refreshes the visible chart's window.
  useEffect(() => {
    return onVisible(() => void refreshWindow());
  }, [refreshWindow]);

  const stale = updatedAt === 0 ? false : isStale(updatedAt, FRESHNESS.candlesStaleAfterMs);
  return {
    candles,
    status: status === "live" && stale ? "stale" : status,
    error,
    updatedAt,
    stale,
  };
}
