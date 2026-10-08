import type { Candle, Market, Timeframe } from "../market/hyperliquid/types";
import { getCachedCandles } from "../market/hyperliquid";
import { getCandleWindow, getClosedCandles } from "../market/hyperliquid/timeframes";
import { buildSignal, SETUP_MIN_CANDLES, type Signal } from "../analysis/signal";
import { assessQuality, type SignalQuality } from "../signals/quality";
import { classifySetupType, signalIdFor, type SetupType } from "../signals/setupType";
import { applyEligibility, type EligibilityConfig, type ExcludedMarket } from "./eligibility";

/**
 * Full-market scan engine. One bounded batch per coin (4 TF fetches),
 * per-coin error isolation (a dead coin never kills the scan), honest
 * counts, and breadth computed from actually scored signals.
 */

export type ScanStatus = "SCANNING" | "COMPLETE" | "ERROR";

export interface ScannedCoin {
  symbol: string;
  signal: Signal;
  setupType: SetupType;
  quality: SignalQuality;
  /** Stable dedupe ID (null for WAIT). */
  id: string | null;
}

export interface MarketBreadth {
  bullishPct: number;
  bearishPct: number;
  neutralPct: number;
  counted: number;
}

export interface ScanSummary {
  status: ScanStatus;
  startedAt: number;
  completedAt: number;
  setupTimeframe: Timeframe;
  results: ScannedCoin[];
  scanned: number;
  excluded: ExcludedMarket[];
  error: string | null;
  breadth: MarketBreadth;
}

export interface ScanOptions {
  eligibility: EligibilityConfig;
  setupTimeframe: Timeframe;
  /** Max concurrent coin batches. */
  concurrency?: number;
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
}

const SCAN_TIMEFRAMES: Timeframe[] = ["4h", "1h", "15m", "5m"];
// Six parallel coin batches (≈24 REST calls in flight at most, usually far
// fewer thanks to the shared candle cache). Eight-plus coincided with the
// snapshot fan-out often enough to trip 429s — fetch behavior only,
// scoring math untouched.
const DEFAULT_CONCURRENCY = 6;

async function boundedAll<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const out: T[] = new Array(tasks.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < tasks.length) {
      const i = next++;
      out[i] = await tasks[i]();
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, tasks.length) }, () => worker()),
  );
  return out;
}

function messageOf(err: unknown): string {
  return err instanceof Error && err.message ? err.message : "Unknown scan error.";
}

export async function runFullScan(
  markets: Market[],
  opts: ScanOptions,
): Promise<ScanSummary> {
  const startedAt = Date.now();
  const { eligible, excluded } = applyEligibility(markets, opts.eligibility);
  const allExcluded: ExcludedMarket[] = [...excluded];
  const results: ScannedCoin[] = [];
  let done = 0;
  let fatalError: string | null = null;

  const abort = opts.signal;
  if (abort?.aborted) {
    return emptySummary(opts.setupTimeframe, startedAt, "Scan cancelled.", allExcluded);
  }

  try {
    await boundedAll(
      eligible.map((market) => async () => {
        if (abort?.aborted) return;
        try {
          const data: Partial<Record<Timeframe, Candle[]>> = {};
          // Closed candles only: the trailing still-forming bar is never
          // scored (indicators, MTF and timestamps all derive from closes).
          const asOf = Date.now();
          const rows = await boundedAll(
            SCAN_TIMEFRAMES.map((tf) => async () => {
              const w = getCandleWindow(tf, asOf, 300);
              const res = await getCachedCandles(market.symbol, tf, w.startTime, w.endTime);
              return { tf, candles: getClosedCandles(res.candles, tf, asOf) };
            }),
            2,
          );
          for (const r of rows) data[r.tf] = r.candles;
          const setup = data[opts.setupTimeframe] ?? [];
          if (setup.length < SETUP_MIN_CANDLES) {
            allExcluded.push({
              symbol: market.symbol,
              reason: `only ${setup.length}/${SETUP_MIN_CANDLES} ${opts.setupTimeframe} candles`,
            });
            return;
          }
          const { signal } = buildSignal({
            symbol: market.symbol,
            setupTimeframe: opts.setupTimeframe,
            candlesByTf: data,
          });
          const setupType = classifySetupType(signal);
          results.push({
            symbol: market.symbol,
            signal,
            setupType,
            quality: assessQuality(signal),
            id: signalIdFor(signal, setupType),
          });
        } catch (err) {
          allExcluded.push({ symbol: market.symbol, reason: messageOf(err) });
        } finally {
          done += 1;
          opts.onProgress?.(done, eligible.length);
        }
      }),
      opts.concurrency ?? DEFAULT_CONCURRENCY,
    );
  } catch (err) {
    fatalError = messageOf(err);
  }

  const completedAt = Date.now();
  if (fatalError && results.length === 0) {
    return {
      status: "ERROR",
      startedAt,
      completedAt,
      setupTimeframe: opts.setupTimeframe,
      results: [],
      scanned: 0,
      excluded: allExcluded,
      error: fatalError,
      breadth: { bullishPct: 0, bearishPct: 0, neutralPct: 0, counted: 0 },
    };
  }
  return {
    status: "COMPLETE",
    startedAt,
    completedAt,
    setupTimeframe: opts.setupTimeframe,
    results: results.sort((a, b) => b.signal.signalStrength - a.signal.signalStrength),
    scanned: results.length,
    excluded: allExcluded,
    error: fatalError,
    breadth: computeBreadth(results),
  };
}

function emptySummary(
  setupTimeframe: Timeframe,
  startedAt: number,
  error: string,
  excluded: ExcludedMarket[],
): ScanSummary {
  return {
    status: "ERROR",
    startedAt,
    completedAt: Date.now(),
    setupTimeframe,
    results: [],
    scanned: 0,
    excluded,
    error,
    breadth: { bullishPct: 0, bearishPct: 0, neutralPct: 0, counted: 0 },
  };
}

/** Breadth from scored signals only — never invented. */
export function computeBreadth(results: ScannedCoin[]): MarketBreadth {
  const counted = results.length;
  if (counted === 0) return { bullishPct: 0, bearishPct: 0, neutralPct: 0, counted: 0 };
  const bull = results.filter((r) => r.signal.direction === "LONG").length;
  const bear = results.filter((r) => r.signal.direction === "SHORT").length;
  const pct = (n: number) => Math.round((n / counted) * 1000) / 10;
  return { bullishPct: pct(bull), bearishPct: pct(bear), neutralPct: pct(counted - bull - bear), counted };
}

/** Ranked HIGH-CONFLUENCE setups: score desc, direction-first, WAIT last. */
export function rankSetups(results: ScannedCoin[]): ScannedCoin[] {
  return [...results].sort((a, b) => {
    const aDir = a.signal.direction === "WAIT" ? 1 : 0;
    const bDir = b.signal.direction === "WAIT" ? 1 : 0;
    if (aDir !== bDir) return aDir - bDir;
    return b.signal.signalStrength - a.signal.signalStrength;
  });
}
