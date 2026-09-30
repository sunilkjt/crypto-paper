import { postInfoWithRetry } from "./client";
import { toHyperliquidInterval, getCandleWindow } from "./timeframes";
import type { Candle, RawCandle, RawWsCandle, Timeframe } from "./types";
import { HyperliquidError } from "./types";

function toFiniteNumber(value: string | number, field: string): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) {
    throw new HyperliquidError(
      "invalid-response",
      `Unable to retrieve Hyperliquid market data (bad candle field ${field}). Retrying…`,
    );
  }
  return n;
}

/** Normalize one raw REST candle (string numerics) into a Candle. */
export function normalizeCandle(raw: RawCandle): Candle {
  if (!raw || typeof raw.t !== "number") {
    throw new HyperliquidError(
      "invalid-response",
      "Unable to retrieve Hyperliquid market data (bad candle shape). Retrying…",
    );
  }
  return {
    timestamp: raw.t,
    open: toFiniteNumber(raw.o, "o"),
    high: toFiniteNumber(raw.h, "h"),
    low: toFiniteNumber(raw.l, "l"),
    close: toFiniteNumber(raw.c, "c"),
    volume: toFiniteNumber(raw.v, "v"),
  };
}

/** Normalize one streaming WS candle (numeric fields) into a Candle. */
export function normalizeWsCandle(raw: RawWsCandle): Candle {
  return normalizeCandle({
    t: raw.t,
    T: raw.T,
    s: raw.s,
    i: raw.i,
    o: String(raw.o),
    h: String(raw.h),
    l: String(raw.l),
    c: String(raw.c),
    v: String(raw.v),
    n: raw.n,
  });
}

/** Normalize a full candleSnapshot payload, sorted ascending, deduped. */
export function normalizeCandles(payload: unknown): Candle[] {
  if (!Array.isArray(payload)) {
    throw new HyperliquidError(
      "invalid-response",
      "Unable to retrieve Hyperliquid market data (bad candles shape). Retrying…",
    );
  }
  const seen = new Set<number>();
  const out: Candle[] = [];
  for (const raw of payload as RawCandle[]) {
    try {
      const c = normalizeCandle(raw);
      if (seen.has(c.timestamp)) continue;
      seen.add(c.timestamp);
      out.push(c);
    } catch {
      // Skip a single corrupt candle rather than failing the whole batch.
      continue;
    }
  }
  out.sort((a, b) => a.timestamp - b.timestamp);
  return out;
}

/**
 * Request casing for coin names. Hyperliquid dex prefixes are lowercase
 * (`xyz:NVDA`) and candle endpoints reject uppercased prefixes, so
 * dex-prefixed names pass through verbatim. Plain main-dex names uppercase
 * exactly as before (no behavior change for existing symbols).
 */
export function coinForRequest(symbol: string): string {
  return symbol.includes(":") ? symbol : symbol.toUpperCase();
}

/**
 * Fetch historical OHLCV candles. UI calls this signature only —
 * never the raw endpoint.
 */
export async function getCandles(
  symbol: string,
  timeframe: Timeframe,
  startTime: number,
  endTime: number,
  opts?: { timeoutMs?: number; signal?: AbortSignal },
): Promise<Candle[]> {
  const coin = coinForRequest(symbol);
  const payload = await postInfoWithRetry(
    {
      type: "candleSnapshot",
      req: {
        coin,
        interval: toHyperliquidInterval(timeframe),
        startTime,
        endTime,
      },
    },
    opts,
  );
  const candles = normalizeCandles(payload);
  if (candles.length === 0) {
    throw new HyperliquidError(
      "missing-candles",
      `No candle data for ${coin} on ${timeframe}. Try another timeframe.`,
      false,
    );
  }
  return candles;
}

/** Convenience: last N candles ending now (default 300). */
export function getRecentCandles(
  symbol: string,
  timeframe: Timeframe,
  limit = 300,
  opts?: { timeoutMs?: number; signal?: AbortSignal },
): Promise<Candle[]> {
  const { startTime, endTime } = getCandleWindow(timeframe, Date.now(), limit);
  return getCandles(symbol, timeframe, startTime, endTime, opts);
}
