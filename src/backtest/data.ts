import type { Candle, Timeframe } from "../market/hyperliquid/types";
import { coinForRequest, getCandles } from "../market/hyperliquid/candles";
import { timeframeToMs } from "../market/hyperliquid/timeframes";
import { postInfoWithRetry } from "../market/hyperliquid/client";
import { HyperliquidError } from "../market/hyperliquid/types";
import type { HistoricalSet } from "./types";

/**
 * Historical data through the existing market-data architecture.
 * Chunked range fetches (bounded concurrency) + optional funding history.
 * Funding absence is reported, never fabricated.
 */

const CHUNK_CANDLES = 4000;
const CONCURRENCY = 4;

async function boundedAll<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const out: T[] = new Array(tasks.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < tasks.length) {
      const i = next++;
      out[i] = await tasks[i]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, () => worker()));
  return out;
}

export async function fetchHistoricalCandles(
  symbol: string,
  timeframe: Timeframe,
  startTime: number,
  endTime: number,
  onProgress?: (done: number, total: number) => void,
): Promise<Candle[]> {
  const coin = coinForRequest(symbol);
  const span = timeframeToMs(timeframe) * CHUNK_CANDLES;
  const windows: { start: number; end: number }[] = [];
  for (let s = startTime; s < endTime; s += span) {
    windows.push({ start: s, end: Math.min(s + span, endTime) });
  }
  let done = 0;
  const batches = await boundedAll(
    windows.map(({ start, end }) => async () => {
      const candles = await getCandles(coin, timeframe, start, end);
      done += 1;
      onProgress?.(done, windows.length);
      return candles;
    }),
    CONCURRENCY,
  );
  const seen = new Set<number>();
  const out: Candle[] = [];
  for (const batch of batches) {
    for (const c of batch) {
      if (c.timestamp < startTime || c.timestamp > endTime || seen.has(c.timestamp)) continue;
      seen.add(c.timestamp);
      out.push(c);
    }
  }
  out.sort((a, b) => a.timestamp - b.timestamp);
  return out;
}

interface RawFunding {
  fundingRate?: string;
  time?: number;
}

/** Best-effort funding history; empty array = unavailable (labeled, not faked). */
export async function fetchFundingHistory(
  symbol: string,
  startTime: number,
  endTime: number,
): Promise<{ timestamp: number; rate: number }[]> {
  try {
    const payload = await postInfoWithRetry(
      { type: "fundingHistory", coin: coinForRequest(symbol), startTime, endTime },
      { timeoutMs: 12_000 },
    );
    if (!Array.isArray(payload)) return [];
    const out: { timestamp: number; rate: number }[] = [];
    for (const r of payload as RawFunding[]) {
      const rate = Number(r.fundingRate);
      if (typeof r.time === "number" && Number.isFinite(rate)) {
        out.push({ timestamp: r.time, rate });
      }
    }
    return out.sort((a, b) => a.timestamp - b.timestamp);
  } catch (err) {
    if (err instanceof HyperliquidError) return [];
    return [];
  }
}

export async function fetchHistoricalSet(
  symbol: string,
  timeframe: Timeframe,
  startTime: number,
  endTime: number,
  onProgress?: (done: number, total: number) => void,
): Promise<HistoricalSet> {
  const [candles, fundingSamples] = await Promise.all([
    fetchHistoricalCandles(symbol, timeframe, startTime, endTime, onProgress),
    fetchFundingHistory(symbol, startTime, endTime),
  ]);
  return { candles, fundingAvailable: fundingSamples.length > 0, fundingSamples };
}
