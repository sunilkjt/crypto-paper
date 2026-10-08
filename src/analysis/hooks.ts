import { useEffect, useMemo, useRef, useState } from "react";
import type { Candle, Timeframe } from "../market/hyperliquid/types";
import { getCachedCandles } from "../market/hyperliquid";
import { getCandleWindow, getClosedCandles } from "../market/hyperliquid/timeframes";
import { buildSignal, isListableBounce, type Signal } from "./signal";

/**
 * React bindings for the deterministic engine. All network goes through
 * the cached market layer; concurrency is bounded so scans stay polite.
 * Stale snapshots never mint fresh signals — callers gate on store.stale.
 */

async function boundedAll<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const out: T[] = new Array(tasks.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < tasks.length) {
      const i = next++;
      out[i] = await tasks[i]();
    }
  }
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => worker());
  await Promise.all(workers);
  return out;
}

export interface MtfCandles {
  data: Partial<Record<Timeframe, Candle[]>>;
  loading: boolean;
  error: string | null;
}

/** Full 4-TF candle set for one coin (4h/1h/15m/5m, 300 bars each). */
export function useMtfCandles(symbol: string): MtfCandles {
  const coin = symbol.toUpperCase();
  const [data, setData] = useState<Partial<Record<Timeframe, Candle[]>>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setData({});
    const tfs: Timeframe[] = ["4h", "1h", "15m", "5m"];
    boundedAll(
      tfs.map((tf) => async () => {
        const w = getCandleWindow(tf, Date.now(), 300);
        const res = await getCachedCandles(coin, tf, w.startTime, w.endTime);
        return { tf, candles: res.candles };
      }),
      4,
    )
      .then((rows) => {
        if (cancelled) return;
        const next: Partial<Record<Timeframe, Candle[]>> = {};
        for (const r of rows) next[r.tf] = r.candles;
        setData(next);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Unable to load candles.");
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [coin]);

  return { data, loading, error };
}

/** Memoized full signal for one coin from its MTF candle set. */
export function useSignal(
  symbol: string,
  mtf: Partial<Record<Timeframe, Candle[]>>,
  setupTimeframe: Timeframe = "15m",
): Signal | null {
  return useMemo(() => {
    if (!mtf[setupTimeframe] || mtf[setupTimeframe].length === 0) return null;
    try {
      // Closed candles only (charts may show the forming bar; the engine never scores it).
      const asOf = Date.now();
      const closed: Partial<Record<Timeframe, Candle[]>> = {};
      for (const tf of ["4h", "1h", "15m", "5m"] as Timeframe[]) {
        if (mtf[tf]) closed[tf] = getClosedCandles(mtf[tf] as Candle[], tf, asOf);
      }
      return buildSignal({ symbol: symbol.toUpperCase(), setupTimeframe, candlesByTf: closed }).signal;
    } catch {
      return null;
    }
  }, [symbol, mtf, setupTimeframe]);
}

export interface BatchEntry {
  symbol: string;
  signal: Signal | null;
  error: string | null;
}

/**
 * Full MTF signals for a batch of symbols (bounded concurrency).
 * Used by Scanner (visible page) and Bounce (top-volume universe).
 */
export function useSignalBatch(symbols: string[], setupTimeframe: Timeframe = "15m"): {
  entries: BatchEntry[];
  loading: boolean;
  done: number;
  total: number;
} {
  const key = useMemo(
    () => [...new Set(symbols.map((s) => s.toUpperCase()))].sort().join(","),
    [symbols],
  );
  const [entries, setEntries] = useState<BatchEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(0);
  const runId = useRef(0);

  useEffect(() => {
    const list = key === "" ? [] : key.split(",");
    const id = ++runId.current;
    setEntries(list.map((symbol) => ({ symbol, signal: null, error: null })));
    setDone(0);
    if (list.length === 0) {
      setLoading(false);
      return;
    }
    setLoading(true);
    let cancelled = false;
    const tfs: Timeframe[] = ["4h", "1h", "15m", "5m"];
    boundedAll(
      list.map((symbol) => async () => {
        const fetchedAt = Date.now();
        const data: Partial<Record<Timeframe, Candle[]>> = {};
        try {
          const rows = await boundedAll(
            tfs.map((tf) => async () => {
              const w = getCandleWindow(tf, fetchedAt, 300);
              const res = await getCachedCandles(symbol, tf, w.startTime, w.endTime);
              // Closed candles only (see useSignal).
              return { tf, candles: getClosedCandles(res.candles, tf, fetchedAt) };
            }),
            2,
          );
          for (const r of rows) data[r.tf] = r.candles;
          const signal = buildSignal({ symbol, setupTimeframe, candlesByTf: data }).signal;
          return { symbol, signal, error: null as string | null };
        } catch (err) {
          return {
            symbol,
            signal: null,
            error: err instanceof Error ? err.message : "Analysis failed.",
          };
        }
      }),
      4,
    )
      .then((rows) => {
        if (cancelled || runId.current !== id) return;
        setEntries(rows);
        setDone(rows.length);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled || runId.current !== id) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return { entries, loading, done, total: key === "" ? 0 : key.split(",").length };
}

export { isListableBounce };
