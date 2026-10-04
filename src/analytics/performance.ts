import type { Candle } from "../market/hyperliquid/types";
import type { MarketCategory } from "../market/classify";

/**
 * Signal performance analytics — measurement ONLY. No strategy, scoring,
 * threshold or indicator code lives here; every input is an already-
 * generated signal plus the candles that printed AFTER it (never future
 * data rewritten into the past, never recalculated entries).
 *
 * Exit model mirrors paper trading exactly: equal thirds exit at
 * TP1/TP2/TP3, and on any single bar the stop is processed BEFORE targets
 * (same conservative same-bar rule as the paper engine and backtester).
 * R multiples therefore match what a thirds-based paper trade would have
 * realized — without leverage, without fees, without invention.
 */

export type SignalVerdict = "WIN" | "LOSS" | "BREAKEVEN" | "EXPIRED" | "OPEN" | "UNKNOWN";

/** |R| at or below this reads as breakeven (noise, not edge). */
export const BREAKEVEN_TOL_R = 0.1;

/** Default maximum signal lifetime (matches signal expiry). Configurable per call. */
export const DEFAULT_OUTCOME_LIFETIME_MS = 24 * 60 * 60 * 1000;

/** Warn when fewer than this many completed signals back the headline. */
export const MIN_SAMPLE_WARNING = 30;

export interface ReplayInput {
  direction: "LONG" | "SHORT";
  entryMid: number;
  risk: number;
  invalidation: number;
  tp1: number;
  tp2: number;
  tp3: number;
  /** Candles strictly AFTER the signal bar, oldest first. */
  followCandles: Candle[];
  /** Signal timestamp (lifetime is measured from here). */
  signalTs: number;
  maxLifetimeMs?: number;
}

export interface ReplayResult {
  verdict: SignalVerdict;
  /** Realized R under thirds exits (null unless terminal WIN/LOSS/BREAKEVEN). */
  realizedR: number | null;
  /** Price of the final exit event (null unless terminal). */
  exitPrice: number | null;
  /** Timestamp of the deciding event (lifetime end for EXPIRED, null for OPEN/UNKNOWN). */
  outcomeAt: number | null;
  /** Human-readable exit path, e.g. "TP1→TP2→TP3", "TP1→STOP", "STOP", "EXPIRED". */
  decidedBy: string;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

function thirdR(direction: "LONG" | "SHORT", entryMid: number, risk: number, exitPx: number): number {
  return direction === "LONG" ? (exitPx - entryMid) / risk : (entryMid - exitPx) / risk;
}

/**
 * Replay equal-thirds exits over post-signal candles. Pure; never mutates
 * inputs. Candles past the lifetime are ignored (no look-ahead beyond the
 * configured horizon); candles are consumed oldest-first (no future data
 * reordered into the past).
 */
export function replayThirds(input: ReplayInput): ReplayResult {
  const { direction, entryMid, risk, invalidation, tp1, tp2, tp3, signalTs } = input;
  const maxLifetimeMs = input.maxLifetimeMs ?? DEFAULT_OUTCOME_LIFETIME_MS;
  const isLong = direction === "LONG";

  if (
    !Number.isFinite(entryMid) || entryMid <= 0 ||
    !(risk > 0) || !Number.isFinite(risk) ||
    !Number.isFinite(invalidation) || invalidation <= 0 ||
    !Number.isFinite(tp1) || !Number.isFinite(tp2) || !Number.isFinite(tp3)
  ) {
    return { verdict: "UNKNOWN", realizedR: null, exitPrice: null, outcomeAt: null, decidedBy: "UNKNOWN" };
  }
  // Wrong-side stop = unmeasurable plan (never silently scored).
  const stopDist = isLong ? entryMid - invalidation : invalidation - entryMid;
  if (!(stopDist > 0)) {
    return { verdict: "UNKNOWN", realizedR: null, exitPrice: null, outcomeAt: null, decidedBy: "UNKNOWN" };
  }

  const horizon = signalTs + maxLifetimeMs;
  const candles = input.followCandles.filter(
    (c) => Number.isFinite(c.timestamp) && c.timestamp > signalTs && c.timestamp <= horizon,
  );
  if (candles.length === 0) {
    // No post-signal price action observed: genuinely cannot determine.
    // (Callers distinguish OPEN vs UNKNOWN via wall-clock vs lifetime.)
    return { verdict: "UNKNOWN", realizedR: null, exitPrice: null, outcomeAt: null, decidedBy: "UNKNOWN" };
  }

  const targets = [tp1, tp2, tp3];
  const names = ["TP1", "TP2", "TP3"];
  let thirdsLeft = 3;
  let realized = 0;
  let lastExit: number | null = null;
  let lastExitTs: number | null = null;
  const path: string[] = [];

  for (const c of candles) {
    if (thirdsLeft === 0) break;
    const stopTouched = isLong ? c.low <= invalidation : c.high >= invalidation;
    if (stopTouched) {
      // Conservative: the whole remaining position exits at the stop.
      // Each third contributes its R divided by 3 (equal-thirds allocation,
      // identical to the paper engine's realizedR) — a full stop is exactly
      // -1R, a full TP1/TP2/TP3 cascade exactly (1+2+3)/3 = +2R.
      while (thirdsLeft > 0) {
        realized += thirdR(direction, entryMid, risk, invalidation) / 3;
        thirdsLeft -= 1;
      }
      path.push("STOP");
      lastExit = invalidation;
      lastExitTs = c.timestamp;
      break;
    }
    const idx = 3 - thirdsLeft;
    const level = targets[idx];
    const touched = isLong ? c.high >= level : c.low <= level;
    if (touched) {
      realized += thirdR(direction, entryMid, risk, level) / 3;
      thirdsLeft -= 1;
      path.push(names[idx]);
      lastExit = level;
      lastExitTs = c.timestamp;
    }
  }

  if (thirdsLeft === 0 && lastExit !== null && lastExitTs !== null) {
    const r = round2(realized);
    const verdict: SignalVerdict = r > BREAKEVEN_TOL_R ? "WIN" : r < -BREAKEVEN_TOL_R ? "LOSS" : "BREAKEVEN";
    return { verdict, realizedR: r, exitPrice: lastExit, outcomeAt: lastExitTs, decidedBy: path.join("→") };
  }

  // Position still open: lifetime reached → EXPIRED, else data ran out → OPEN.
  const lastTs = candles[candles.length - 1].timestamp;
  if (lastTs >= horizon - 1) {
    return { verdict: "EXPIRED", realizedR: null, exitPrice: null, outcomeAt: horizon, decidedBy: "EXPIRED" };
  }
  return { verdict: "OPEN", realizedR: null, exitPrice: null, outcomeAt: null, decidedBy: "OPEN" };
}

export interface ResolvedSignal {
  id: string;
  symbol: string;
  category: MarketCategory | "other";
  direction: "LONG" | "SHORT";
  timeframe: string;
  score: number;
  firstSeen: number;
  /** Mid of the signal entry zone (null when the plan stored no entry). */
  entryMid: number | null;
  verdict: SignalVerdict;
  realizedR: number | null;
  exitPrice: number | null;
  outcomeAt: number | null;
  decidedBy: string;
}

export interface GroupStats {
  key: string;
  signals: number;
  wins: number;
  losses: number;
  winRate: number;
  avgR: number;
  profitFactor: number;
  expectancy: number;
  cumulativeR: number;
}

export interface PerformanceStats {
  total: number;
  wins: number;
  losses: number;
  breakeven: number;
  open: number;
  expired: number;
  unknown: number;
  completed: number;
  winRate: number;
  avgR: number;
  profitFactor: number;
  expectancy: number;
  cumulativeR: { n: number; cumulativeR: number; outcomeAt: number; id: string }[];
  byCategory: GroupStats[];
  byDirection: GroupStats[];
  byScore: GroupStats[];
  byTimeframe: GroupStats[];
  bySymbol: GroupStats[];
}

function groupStats(key: string, rows: ResolvedSignal[]): GroupStats {
  const done = rows.filter((r) => r.verdict === "WIN" || r.verdict === "LOSS" || r.verdict === "BREAKEVEN");
  const wins = rows.filter((r) => r.verdict === "WIN").length;
  const losses = rows.filter((r) => r.verdict === "LOSS").length;
  const rs = done.map((r) => r.realizedR ?? 0);
  const grossPos = rs.filter((x) => x > 0).reduce((a, b) => a + b, 0);
  const grossNeg = Math.abs(rs.filter((x) => x <= 0).reduce((a, b) => a + b, 0));
  const avg = rs.length > 0 ? rs.reduce((a, b) => a + b, 0) / rs.length : 0;
  return {
    key,
    signals: done.length,
    wins,
    losses,
    winRate: done.length > 0 ? round2((wins / done.length) * 100) : 0,
    avgR: round2(avg),
    profitFactor: grossNeg > 0 ? round2(grossPos / grossNeg) : grossPos > 0 ? Infinity : 0,
    expectancy: round2(avg),
    cumulativeR: round2(rs.reduce((a, b) => a + b, 0)),
  };
}

export const SCORE_BANDS = ["90–100", "80–89", "70–79", "60–69", "<60"] as const;

export function scoreBand(score: number): string {
  if (score >= 90) return "90–100";
  if (score >= 80) return "80–89";
  if (score >= 70) return "70–79";
  if (score >= 60) return "60–69";
  return "<60";
}

const TIMEFRAME_ORDER = ["5m", "15m", "1h", "4h"];

/** Aggregate headline + grouped stats over resolved signals (completed verdicts only for rates). */
export function computePerformanceStats(rows: ResolvedSignal[]): PerformanceStats {
  const wins = rows.filter((r) => r.verdict === "WIN").length;
  const losses = rows.filter((r) => r.verdict === "LOSS").length;
  const breakeven = rows.filter((r) => r.verdict === "BREAKEVEN").length;
  const completed = rows.filter((r) => r.verdict === "WIN" || r.verdict === "LOSS" || r.verdict === "BREAKEVEN");
  const rs = completed.map((r) => r.realizedR ?? 0);
  const grossPos = rs.filter((x) => x > 0).reduce((a, b) => a + b, 0);
  const grossNeg = Math.abs(rs.filter((x) => x <= 0).reduce((a, b) => a + b, 0));
  const avg = rs.length > 0 ? rs.reduce((a, b) => a + b, 0) / rs.length : 0;

  let running = 0;
  const cumulativeR = [...completed]
    .sort((a, b) => (a.outcomeAt ?? 0) - (b.outcomeAt ?? 0))
    .map((r, i) => {
      running += r.realizedR ?? 0;
      return { n: i + 1, cumulativeR: round2(running), outcomeAt: r.outcomeAt ?? 0, id: r.id };
    });

  const by = (key: (r: ResolvedSignal) => string, order: string[]): GroupStats[] => {
    const keys = [...new Set(rows.map(key))].sort((a, b) => {
      const ia = order.indexOf(a);
      const ib = order.indexOf(b);
      if (ia === -1 && ib === -1) return a.localeCompare(b);
      if (ia === -1) return 1;
      if (ib === -1) return -1;
      return ia - ib;
    });
    return keys.map((k) => groupStats(k, rows.filter((r) => key(r) === k)));
  };

  return {
    total: rows.length,
    wins,
    losses,
    breakeven,
    open: rows.filter((r) => r.verdict === "OPEN").length,
    expired: rows.filter((r) => r.verdict === "EXPIRED").length,
    unknown: rows.filter((r) => r.verdict === "UNKNOWN").length,
    completed: completed.length,
    winRate: completed.length > 0 ? round2((wins / completed.length) * 100) : 0,
    avgR: round2(avg),
    profitFactor: grossNeg > 0 ? round2(grossPos / grossNeg) : grossPos > 0 ? Infinity : 0,
    expectancy: round2(avg),
    cumulativeR,
    byCategory: by((r) => r.category, ["crypto", "stocks", "commodities", "other"]),
    byDirection: by((r) => r.direction, ["LONG", "SHORT"]),
    byScore: by((r) => scoreBand(r.score), [...SCORE_BANDS]),
    byTimeframe: by((r) => r.timeframe, TIMEFRAME_ORDER),
    bySymbol: [...by((r) => r.symbol, [])].sort((a, b) => b.cumulativeR - a.cumulativeR),
  };
}

export type DateRange = "today" | "7d" | "30d" | "all";

export interface PerformanceFilters {
  category: "ALL" | MarketCategory;
  direction: "ALL" | "LONG" | "SHORT";
  minScore: number;
  range: DateRange;
}

/** Filter on signal date (firstSeen): when the setup was generated. */
export function applyPerformanceFilters(
  rows: ResolvedSignal[],
  f: PerformanceFilters,
  now = Date.now(),
): ResolvedSignal[] {
  const dayStart = new Date(now);
  dayStart.setUTCHours(0, 0, 0, 0);
  const cutoff =
    f.range === "today" ? dayStart.getTime() : f.range === "7d" ? now - 7 * 86_400_000 : f.range === "30d" ? now - 30 * 86_400_000 : 0;
  return rows.filter(
    (r) =>
      (f.category === "ALL" || r.category === f.category) &&
      (f.direction === "ALL" || r.direction === f.direction) &&
      r.score >= f.minScore &&
      r.firstSeen >= cutoff,
  );
}
