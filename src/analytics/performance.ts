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

export type SignalVerdict =
  | "WIN"
  | "LOSS"
  | "BREAKEVEN"
  | "EXPIRED"
  | "OPEN"
  | "UNKNOWN"
  | "NO_FILL"
  | "INVALIDATED";

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
  /** Entry zone for activation gating (null = legacy/immediate measurement). */
  entryLow: number | null;
  entryHigh: number | null;
  /**
   * False = RETEST semantics (price must touch the zone before TP/SL
   * monitoring begins). True = MARKET/legacy (active from the signal bar).
   * Defaults true when no zone is provided (back-compatible measurement).
   */
  immediate?: boolean;
  /** Candles strictly AFTER the signal bar, oldest first. */
  followCandles: Candle[];
  /** Signal timestamp (lifetime is measured from here). */
  signalTs: number;
  maxLifetimeMs?: number;
  /** Finer-TF candles for ordering same-bar stop/target touches (optional). */
  finer?: Candle[];
}

export interface AmbiguousBar {
  barOpen: number;
  barClose: number;
  /** The target level that shared the bar with the stop. */
  target: number;
  targetName: string;
}

export interface ReplayResult {
  verdict: SignalVerdict;
  /** Realized R under thirds exits (null unless terminal WIN/LOSS/BREAKEVEN). */
  realizedR: number | null;
  /** Price of the final exit event (null unless terminal). */
  exitPrice: number | null;
  /** Timestamp of the deciding event (lifetime end for EXPIRED/NO_FILL, null for OPEN/UNKNOWN). */
  outcomeAt: number | null;
  /** Human-readable exit path, e.g. "TP1→TP2→TP3", "TP1→STOP", "STOP", "EXPIRED". */
  decidedBy: string;
  /** Whether TP/SL monitoring ever began (false for NO_FILL/INVALIDATED). */
  activated: boolean;
  /** Entry-mid estimate at activation (always estimated — OHLC can't prove a fill). */
  activationPrice: number | null;
  activationTs: number | null;
  /** True when the conservative same-bar fallback was used (reported, never hidden). */
  ambiguous: boolean;
  /** The unresolved same-bar conflict (for finer-TF second passes). */
  ambiguousBar: AmbiguousBar | null;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

function thirdR(direction: "LONG" | "SHORT", entryMid: number, risk: number, exitPx: number): number {
  return direction === "LONG" ? (exitPx - entryMid) / risk : (entryMid - exitPx) / risk;
}

/**
 * Zone intersection for activation: the bar's range overlaps the entry
 * zone. Direction-agnostic by construction (interval overlap) — the same
 * test serves LONG (pullback into support) and SHORT (rally into
 * resistance), exactly as specified.
 */
export function zoneIntersects(
  low: number,
  high: number,
  entryLow: number,
  entryHigh: number,
): boolean {
  return low <= entryHigh && high >= entryLow;
}

/**
 * Order a same-bar stop/target conflict using finer-TF candles inside the
 * bar span. Returns which level printed first, or null when the finer data
 * cannot establish the order (gaps, same finer bar) — callers then fall
 * back to the conservative rule and flag ambiguity. Never fabricates.
 */
export function orderBarTouches(args: {
  finer: Candle[];
  isLong: boolean;
  stop: number;
  target: number;
  barOpen: number;
  barClose: number;
}): "STOP" | "TARGET" | null {
  const { finer, isLong, stop, target, barOpen, barClose } = args;
  const inSpan = finer
    .filter((c) => Number.isFinite(c.timestamp) && c.timestamp >= barOpen && c.timestamp < barClose)
    .sort((a, b) => a.timestamp - b.timestamp);
  for (const c of inSpan) {
    const stopHit = isLong ? c.low <= stop : c.high >= stop;
    const targetHit = isLong ? c.high >= target : c.low <= target;
    if (stopHit && targetHit) return null; // ambiguous at every granularity
    if (stopHit) return "STOP";
    if (targetHit) return "TARGET";
  }
  return null;
}

/**
 * Replay equal-thirds exits over post-signal candles. Pure; never mutates
 * inputs. Candles past the lifetime are ignored (no look-ahead beyond the
 * configured horizon); candles are consumed oldest-first (no future data
 * reordered into the past).
 *
 * Activation gating: RETEST signals (immediate=false) only begin TP/SL
 * monitoring once a bar intersects the entry zone; a stop touch before any
 * zone touch invalidates (never a loss — no fill happened). MARKET and
 * legacy zoneless inputs activate at the signal bar, reproducing the
 * historical measurement exactly.
 */
export function replayThirds(input: ReplayInput): ReplayResult {
  const { direction, entryMid, risk, invalidation, tp1, tp2, tp3, signalTs } = input;
  const maxLifetimeMs = input.maxLifetimeMs ?? DEFAULT_OUTCOME_LIFETIME_MS;
  const isLong = direction === "LONG";
  const idle: ReplayResult = {
    verdict: "UNKNOWN",
    realizedR: null,
    exitPrice: null,
    outcomeAt: null,
    decidedBy: "UNKNOWN",
    activated: false,
    activationPrice: null,
    activationTs: null,
    ambiguous: false,
    ambiguousBar: null,
  };

  if (
    !Number.isFinite(entryMid) || entryMid <= 0 ||
    !(risk > 0) || !Number.isFinite(risk) ||
    !Number.isFinite(invalidation) || invalidation <= 0 ||
    !Number.isFinite(tp1) || !Number.isFinite(tp2) || !Number.isFinite(tp3)
  ) {
    return idle;
  }
  // Wrong-side stop = unmeasurable plan (never silently scored).
  const stopDist = isLong ? entryMid - invalidation : invalidation - entryMid;
  if (!(stopDist > 0)) return idle;

  const zone: [number, number] | null =
    typeof input.entryLow === "number" && typeof input.entryHigh === "number" && input.entryHigh > input.entryLow
      ? [input.entryLow, input.entryHigh]
      : null;
  // Zoneless legacy inputs measure immediately (back-compatible); zoned
  // inputs activate immediately only for MARKET signals.
  const immediate = input.immediate ?? zone === null;

  const horizon = signalTs + maxLifetimeMs;
  const candles = input.followCandles.filter(
    (c) => Number.isFinite(c.timestamp) && c.timestamp > signalTs && c.timestamp <= horizon,
  );
  if (candles.length === 0) {
    // No post-signal price action observed: genuinely cannot determine.
    // (Callers distinguish OPEN vs UNKNOWN via wall-clock vs lifetime.)
    return idle;
  }

  const stopTouched = (c: Candle): boolean => (isLong ? c.low <= invalidation : c.high >= invalidation);
  const finish = (partial: Partial<ReplayResult> & { verdict: SignalVerdict }): ReplayResult => ({
    ...idle,
    ...partial,
  });

  // ---- Phase 1: activation ----
  let startIdx = 0;
  let activationTs: number | null = null;
  if (!immediate && zone !== null) {
    const [entryLow, entryHigh] = zone;
    let found = -1;
    for (let i = 0; i < candles.length; i++) {
      const c = candles[i];
      const inZone = zoneIntersects(c.low, c.high, entryLow, entryHigh);
      const sl = stopTouched(c);
      if (inZone && sl) {
        // Same bar touched zone and stop: order unknowable at this
        // granularity → conservative INVALIDATED, flagged.
        return finish({
          verdict: "INVALIDATED",
          outcomeAt: c.timestamp,
          decidedBy: "INVALIDATED*",
          ambiguous: true,
        });
      }
      if (sl) {
        return finish({ verdict: "INVALIDATED", outcomeAt: c.timestamp, decidedBy: "INVALIDATED" });
      }
      if (inZone) {
        found = i;
        break;
      }
    }
    if (found === -1) {
      const lastTs = candles[candles.length - 1].timestamp;
      if (lastTs >= horizon - 1) {
        return finish({ verdict: "NO_FILL", outcomeAt: horizon, decidedBy: "NO_FILL" });
      }
      return finish({ verdict: "OPEN", decidedBy: "OPEN" });
    }
    startIdx = found;
    activationTs = candles[found].timestamp;
  }

  // ---- Phase 2: thirds exits from the activation bar onward ----
  // Each third contributes its R divided by 3 (equal-thirds allocation,
  // identical to the paper engine's realizedR) — a full stop is exactly
  // -1R, a full TP1/TP2/TP3 cascade exactly (1+2+3)/3 = +2R.
  const targets = [tp1, tp2, tp3];
  const names = ["TP1", "TP2", "TP3"];
  let thirdsLeft = 3;
  let realized = 0;
  let lastExit: number | null = null;
  let lastExitTs: number | null = null;
  let ambiguous = false;
  let ambiguousBar: AmbiguousBar | null = null;
  const path: string[] = [];

  for (let i = startIdx; i < candles.length && thirdsLeft > 0; i++) {
    const c = candles[i];
    const sl = stopTouched(c);
    const idx = 3 - thirdsLeft;
    const level = targets[idx];
    const tp = isLong ? c.high >= level : c.low <= level;
    if (sl && tp) {
      const barOpen = i > 0 ? candles[i - 1].timestamp : signalTs;
      const ordered =
        input.finer && input.finer.length > 0
          ? orderBarTouches({ finer: input.finer, isLong, stop: invalidation, target: level, barOpen, barClose: c.timestamp })
          : null;
      if (ordered === "TARGET") {
        realized += thirdR(direction, entryMid, risk, level) / 3;
        thirdsLeft -= 1;
        path.push(names[idx]);
        lastExit = level;
        lastExitTs = c.timestamp;
        continue;
      }
      // Conservative LOSS (stop-first), flagged; finer data couldn't decide.
      while (thirdsLeft > 0) {
        realized += thirdR(direction, entryMid, risk, invalidation) / 3;
        thirdsLeft -= 1;
      }
      path.push("STOP*");
      lastExit = invalidation;
      lastExitTs = c.timestamp;
      ambiguous = true;
      ambiguousBar = { barOpen, barClose: c.timestamp, target: level, targetName: names[idx] };
      break;
    }
    if (sl) {
      while (thirdsLeft > 0) {
        realized += thirdR(direction, entryMid, risk, invalidation) / 3;
        thirdsLeft -= 1;
      }
      path.push("STOP");
      lastExit = invalidation;
      lastExitTs = c.timestamp;
      break;
    }
    if (tp) {
      realized += thirdR(direction, entryMid, risk, level) / 3;
      thirdsLeft -= 1;
      path.push(names[idx]);
      lastExit = level;
      lastExitTs = c.timestamp;
    }
  }

  const activatedOut = {
    activated: true,
    activationPrice: entryMid,
    activationTs: activationTs ?? signalTs,
  };
  if (thirdsLeft === 0 && lastExit !== null && lastExitTs !== null) {
    const r = round2(realized);
    const verdict: SignalVerdict = r > BREAKEVEN_TOL_R ? "WIN" : r < -BREAKEVEN_TOL_R ? "LOSS" : "BREAKEVEN";
    return finish({
      verdict,
      realizedR: r,
      exitPrice: lastExit,
      outcomeAt: lastExitTs,
      decidedBy: path.join("→") + (ambiguous ? " (ambiguous bar)" : ""),
      ...activatedOut,
      ambiguous,
      ambiguousBar,
    });
  }

  // Position still open: lifetime reached → EXPIRED, else data ran out → OPEN.
  const lastTs = candles[candles.length - 1].timestamp;
  if (lastTs >= horizon - 1) {
    return finish({
      verdict: "EXPIRED",
      outcomeAt: horizon,
      decidedBy: `${path.length > 0 ? path.join("→") + "→" : ""}EXPIRED`,
      ...activatedOut,
      ambiguous,
      ambiguousBar,
    });
  }
  return finish({
    verdict: "OPEN",
    decidedBy: path.length > 0 ? path.join("→") : "OPEN",
    ...activatedOut,
    ambiguous,
    ambiguousBar,
  });
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
  /** Full stored plan legs (null when unrecorded). Display only — never recalculated. */
  entryLow: number | null;
  entryHigh: number | null;
  invalidation: number | null;
  tp1: number | null;
  tp2: number | null;
  tp3: number | null;
  riskReward: number | null;
  /** Engine entry type at generation (null for legacy rows). */
  entryType: "MARKET" | "RETEST" | null;
  /** Last time the row was seen/updated server-side. */
  lastSeen: number | null;
  /** When the resolver wrote the verdict (null while unresolved). */
  resolvedAt: number | null;
  /** Stored reasons (empty when unrecorded — never invented). */
  reasons: string[];
  verdict: SignalVerdict;
  realizedR: number | null;
  exitPrice: number | null;
  outcomeAt: number | null;
  decidedBy: string;
  /** Estimated activation price (entry-mid estimate, null when never activated). */
  activationPrice: number | null;
  activationTs: number | null;
  /** True when a conservative same-bar fallback decided the outcome. */
  ambiguous: boolean;
  /** Setup classification at generation time (null when unrecorded). */
  setupType: string | null;
  /** Engine quality tag at generation time (null when unrecorded). */
  quality: string | null;
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
  noFill: number;
  invalidated: number;
  ambiguous: number;
  /** Signals whose TP/SL monitoring began (all terminal WIN/LOSS/BREAKEVEN/EXPIRED). */
  activated: number;
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
    noFill: rows.filter((r) => r.verdict === "NO_FILL").length,
    invalidated: rows.filter((r) => r.verdict === "INVALIDATED").length,
    ambiguous: rows.filter((r) => r.ambiguous).length,
    activated: completed.length + rows.filter((r) => r.verdict === "EXPIRED").length,
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
