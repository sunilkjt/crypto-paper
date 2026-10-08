import {
  computePerformanceStats,
  scoreBand,
  type GroupStats,
  type PerformanceStats,
  type ResolvedSignal,
} from "./performance";

/**
 * Continuous signal-quality measurement — detection only, never tuning.
 * Every function here is pure: same rows in, same verdicts out. Nothing
 * in this module may import the strategy (analysis/signal, scanner
 * engine), write to any store, or call any network. The headless runner
 * (`scripts/signal-quality-test.ts`) is the only IO shell, and it is
 * read-only apart from report files.
 */

export type SampleClass = "INSUFFICIENT_DATA" | "EARLY" | "DEVELOPING" | "MEANINGFUL";

/** <20 insufficient · 20–49 early · 50–99 developing · 100+ meaningful. */
export function classifySample(completed: number): SampleClass {
  if (completed < 20) return "INSUFFICIENT_DATA";
  if (completed < 50) return "EARLY";
  if (completed < 100) return "DEVELOPING";
  return "MEANINGFUL";
}

export type QualityStatus = "HEALTHY" | "WATCH" | "WARNING" | "CRITICAL" | "INSUFFICIENT_DATA";

export type AlertDomain = "STRATEGY" | "DATA" | "RESOLVER" | "CRON" | "DATABASE";
export type AlertSeverity = "WATCH" | "WARNING" | "CRITICAL";

export interface QualityAlert {
  severity: AlertSeverity;
  domain: AlertDomain;
  code: string;
  message: string;
  evidence: string;
}

/** Finer score buckets for quality analysis (page bands stay as specified). */
export const QUALITY_BANDS = ["90+", "85–89", "80–84", "75–79", "70–74", "<70"] as const;

export function qualityBand(score: number): string {
  if (score >= 90) return "90+";
  if (score >= 85) return "85–89";
  if (score >= 80) return "80–84";
  if (score >= 75) return "75–79";
  if (score >= 70) return "70–74";
  return "<70";
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

export interface ExtendedMetrics {
  medianR: number;
  maxWinStreak: number;
  maxLossStreak: number;
  byScore5: GroupStats[];
  byEntry: GroupStats[];
  bySetup: GroupStats[];
  byQuality: GroupStats[];
  tp1Rate: number;
  tp2Rate: number;
  tp3Rate: number;
  ambiguousRate: number;
  noFillRate: number;
  invalidatedRate: number;
}

function groupStatsFor(key: (r: ResolvedSignal) => string, order: string[], rows: ResolvedSignal[]): GroupStats[] {
  const keys = [...new Set(rows.map(key))].sort((a, b) => {
    const ia = order.indexOf(a);
    const ib = order.indexOf(b);
    if (ia === -1 && ib === -1) return a.localeCompare(b);
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });
  // Reuse the shared completed-only group math via a synthetic stats pass.
  const out: GroupStats[] = [];
  for (const k of keys) {
    const group = rows.filter((r) => key(r) === k);
    const done = group.filter((r) => r.verdict === "WIN" || r.verdict === "LOSS" || r.verdict === "BREAKEVEN");
    const wins = group.filter((r) => r.verdict === "WIN").length;
    const rs = done.map((r) => r.realizedR ?? 0);
    const grossPos = rs.filter((x) => x > 0).reduce((a, b) => a + b, 0);
    const grossNeg = Math.abs(rs.filter((x) => x <= 0).reduce((a, b) => a + b, 0));
    const avg = rs.length > 0 ? rs.reduce((a, b) => a + b, 0) / rs.length : 0;
    out.push({
      key: k,
      signals: done.length,
      wins,
      losses: group.filter((r) => r.verdict === "LOSS").length,
      winRate: done.length > 0 ? round2((wins / done.length) * 100) : 0,
      avgR: round2(avg),
      profitFactor: grossNeg > 0 ? round2(grossPos / grossNeg) : grossPos > 0 ? Infinity : 0,
      expectancy: round2(avg),
      cumulativeR: round2(rs.reduce((a, b) => a + b, 0)),
    });
  }
  return out;
}

/** Extended metrics over resolved rows (completed verdicts only for rates). */
export function computeExtendedMetrics(rows: ResolvedSignal[]): ExtendedMetrics {
  const done = rows.filter((r) => r.verdict === "WIN" || r.verdict === "LOSS" || r.verdict === "BREAKEVEN");
  const rs = [...done].sort((a, b) => (a.outcomeAt ?? 0) - (b.outcomeAt ?? 0));
  const vals = rs.map((r) => r.realizedR ?? 0).sort((a, b) => a - b);
  const mid = Math.floor(vals.length / 2);
  const medianR = vals.length === 0 ? 0 : vals.length % 2 === 1 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2;
  let maxWin = 0;
  let maxLoss = 0;
  let curWin = 0;
  let curLoss = 0;
  for (const r of rs) {
    if (r.verdict === "WIN") {
      curWin += 1;
      curLoss = 0;
      maxWin = Math.max(maxWin, curWin);
    } else if (r.verdict === "LOSS") {
      curLoss += 1;
      curWin = 0;
      maxLoss = Math.max(maxLoss, curLoss);
    } else {
      curWin = 0;
      curLoss = 0;
    }
  }
  const activated = rows.filter(
    (r) => r.verdict === "WIN" || r.verdict === "LOSS" || r.verdict === "BREAKEVEN" || r.verdict === "EXPIRED",
  );
  const pathHas = (t: string): number =>
    activated.filter((r) => r.decidedBy.includes(t)).length;
  return {
    medianR: round2(medianR),
    maxWinStreak: maxWin,
    maxLossStreak: maxLoss,
    byScore5: groupStatsFor((r) => qualityBand(r.score), [...QUALITY_BANDS], rows),
    byEntry: groupStatsFor(
      (r) => (r.activationTs !== null ? "ACTIVATED" : "NOT_ACTIVATED"),
      ["ACTIVATED", "NOT_ACTIVATED"],
      rows,
    ),
    bySetup: groupStatsFor((r) => r.setupType ?? "UNKNOWN", ["BOUNCE", "BREAKOUT", "BREAKDOWN", "PULLBACK", "REVERSAL", "TREND", "RANGE", "UNKNOWN"], rows),
    byQuality: groupStatsFor((r) => r.quality ?? "UNKNOWN", ["HIGH QUALITY", "MEDIUM QUALITY", "LOW QUALITY", "UNKNOWN"], rows),
    tp1Rate: activated.length > 0 ? round2((pathHas("TP1") / activated.length) * 100) : 0,
    tp2Rate: activated.length > 0 ? round2((pathHas("TP2") / activated.length) * 100) : 0,
    tp3Rate: activated.length > 0 ? round2((pathHas("TP3") / activated.length) * 100) : 0,
    ambiguousRate: activated.length > 0 ? round2((activated.filter((r) => r.ambiguous).length / activated.length) * 100) : 0,
    noFillRate: rows.length > 0 ? round2((rows.filter((r) => r.verdict === "NO_FILL").length / rows.length) * 100) : 0,
    invalidatedRate: rows.length > 0 ? round2((rows.filter((r) => r.verdict === "INVALIDATED").length / rows.length) * 100) : 0,
  };
}

export interface StrategyAlertInput {
  stats: PerformanceStats;
  ext: ExtendedMetrics;
  rows: ResolvedSignal[];
}

/**
 * Strategy problem detection. Every rule carries an explicit minimum
 * sample gate — below it the rule stays silent (no conclusions from
 * noise). Returns alerts sorted CRITICAL → WARNING → WATCH.
 */
export function detectStrategyProblems(input: StrategyAlertInput): QualityAlert[] {
  const { stats, ext, rows } = input;
  const out: QualityAlert[] = [];
  const band = (b: string): GroupStats | undefined => ext.byScore5.find((g) => g.key === b);
  const dir = (d: string): GroupStats | undefined => stats.byDirection.find((g) => g.key === d);

  const top = band("90+");
  const low = band("70–74");
  if (top && low && top.signals >= 10 && low.signals >= 10 && top.avgR < low.avgR) {
    out.push({
      severity: "WARNING",
      domain: "STRATEGY",
      code: "SCORE_INVERSION",
      message: `Score 90+ averaging ${top.avgR}R underperforms 70–74 at ${low.avgR}R.`,
      evidence: `90+: n=${top.signals} avgR=${top.avgR}; 70–74: n=${low.signals} avgR=${low.avgR}`,
    });
  }

  const longs = dir("LONG");
  const shorts = dir("SHORT");
  if (longs && shorts && longs.signals >= 15 && shorts.signals >= 15 && Math.abs(longs.avgR - shorts.avgR) > 0.5) {
    out.push({
      severity: "WATCH",
      domain: "STRATEGY",
      code: "DIRECTION_DIVERGENCE",
      message: `LONG (${longs.avgR}R) and SHORT (${shorts.avgR}R) diverge by more than 0.5R.`,
      evidence: `LONG n=${longs.signals} avgR=${longs.avgR}; SHORT n=${shorts.signals} avgR=${shorts.avgR}`,
    });
  }

  for (const g of stats.bySymbol) {
    if (g.signals >= 5 && g.avgR < -0.5) {
      out.push({
        severity: "WATCH",
        domain: "STRATEGY",
        code: "SYMBOL_OUTLIER",
        message: `${g.key} shows abnormal losses (${g.avgR}R over ${g.signals} completed).`,
        evidence: `${g.key}: n=${g.signals} winRate=${g.winRate}% avgR=${g.avgR}`,
      });
    }
  }

  for (const g of stats.byCategory) {
    if (g.signals >= 15 && g.avgR < stats.avgR - 0.5) {
      out.push({
        severity: "WATCH",
        domain: "STRATEGY",
        code: "CATEGORY_LAG",
        message: `${g.key} trails the overall average by more than 0.5R.`,
        evidence: `${g.key}: n=${g.signals} avgR=${g.avgR} vs overall ${stats.avgR}`,
      });
    }
  }

  if (stats.completed >= 20 && stats.profitFactor < 1) {
    out.push({
      severity: "WARNING",
      domain: "STRATEGY",
      code: "PF_BELOW_ONE",
      message: `Profit factor ${stats.profitFactor} is below 1.0 over ${stats.completed} completed.`,
      evidence: `completed=${stats.completed} pf=${stats.profitFactor}`,
    });
  }
  if (stats.completed >= 20 && stats.expectancy < 0) {
    out.push({
      severity: "WARNING",
      domain: "STRATEGY",
      code: "EXPECTANCY_NEGATIVE",
      message: `Expectancy ${stats.expectancy}R is negative over ${stats.completed} completed.`,
      evidence: `completed=${stats.completed} expectancy=${stats.expectancy}`,
    });
  }

  const retestNoFill = rows.filter((r) => r.verdict === "NO_FILL").length;
  const retestPool = rows.filter((r) => r.verdict === "NO_FILL" || r.activationTs !== null).length;
  if (retestPool >= 20 && retestNoFill / retestPool > 0.5) {
    out.push({
      severity: "WARNING",
      domain: "STRATEGY",
      code: "RETEST_NO_FILL_HIGH",
      message: `NO_FILL rate ${Math.round((retestNoFill / retestPool) * 100)}% exceeds 50% — entries may be unreachable.`,
      evidence: `noFill=${retestNoFill} pool=${retestPool}`,
    });
  }

  if (ext.ambiguousRate > 15) {
    const activated = stats.wins + stats.losses + rows.filter((r) => r.verdict === "BREAKEVEN").length;
    if (activated >= 20) {
      out.push({
        severity: "WATCH",
        domain: "STRATEGY",
        code: "AMBIGUOUS_HIGH",
        message: `Ambiguous-bar rate ${ext.ambiguousRate}% is unusually high.`,
        evidence: `ambiguousRate=${ext.ambiguousRate}%`,
      });
    }
  }

  const order: Record<AlertSeverity, number> = { CRITICAL: 0, WARNING: 1, WATCH: 2 };
  return out.sort((a, b) => order[a.severity] - order[b.severity]);
}

export interface InfraInput {
  now: number;
  cronLastRunAt: number | null;
  resolverAt: number | null;
  unresolvedCount: number;
  oldestUnresolvedAt: number | null;
  totalSignals: number;
  lastSignalAt: number | null;
  dbError: string | null;
  marketProbeOk: boolean | null;
  recentSignals: number;
  priorSignals: number;
}

export const CRON_WARN_MS = 15 * 60_000;
export const CRON_CRITICAL_MS = 60 * 60_000;
export const RESOLVER_WARN_MS = 45 * 60_000;
export const RESOLVER_CRITICAL_MS = 180 * 60_000;

/**
 * Infrastructure/data problem detection. Never blames the strategy for
 * missing data: with no fresh signals and a stale cron, the verdict is a
 * CRON problem, not a strategy verdict.
 */
export function detectInfraProblems(input: InfraInput): QualityAlert[] {
  const out: QualityAlert[] = [];
  if (input.dbError) {
    out.push({
      severity: "CRITICAL",
      domain: "DATABASE",
      code: "DB_UNREADABLE",
      message: "Signal history is unreadable.",
      evidence: input.dbError,
    });
    return out;
  }
  const cronAge = input.cronLastRunAt === null ? null : input.now - input.cronLastRunAt;
  if (cronAge === null) {
    out.push({
      severity: "WARNING",
      domain: "CRON",
      code: "CRON_MISSING",
      message: "The 24/7 scanner has never reported a heartbeat.",
      evidence: "scanner_state has no cron-monitor row",
    });
  } else if (cronAge > CRON_CRITICAL_MS) {
    out.push({
      severity: "CRITICAL",
      domain: "CRON",
      code: "CRON_STALE",
      message: `No successful cron scan for ${Math.round(cronAge / 60_000)} minutes.`,
      evidence: `lastRun age=${Math.round(cronAge / 60_000)}m`,
    });
  } else if (cronAge > CRON_WARN_MS) {
    out.push({
      severity: "WARNING",
      domain: "CRON",
      code: "CRON_DELAYED",
      message: `Cron heartbeat delayed ${Math.round(cronAge / 60_000)} minutes.`,
      evidence: `lastRun age=${Math.round(cronAge / 60_000)}m`,
    });
  }
  const resAge = input.resolverAt === null ? null : input.now - input.resolverAt;
  if (resAge === null) {
    out.push({
      severity: "WARNING",
      domain: "RESOLVER",
      code: "RESOLVER_MISSING",
      message: "The outcome resolver has never reported a heartbeat.",
      evidence: "scanner_state has no resolve-outcomes row",
    });
  } else if (resAge > RESOLVER_CRITICAL_MS) {
    out.push({
      severity: "CRITICAL",
      domain: "RESOLVER",
      code: "RESOLVER_STALE",
      message: `Resolver heartbeat stale for ${Math.round(resAge / 60_000)} minutes.`,
      evidence: `resolver age=${Math.round(resAge / 60_000)}m`,
    });
  } else if (resAge > RESOLVER_WARN_MS) {
    out.push({
      severity: "WARNING",
      domain: "RESOLVER",
      code: "RESOLVER_DELAYED",
      message: `Resolver heartbeat delayed ${Math.round(resAge / 60_000)} minutes.`,
      evidence: `resolver age=${Math.round(resAge / 60_000)}m`,
    });
  }
  if (input.unresolvedCount > 50 && input.oldestUnresolvedAt !== null && input.now - input.oldestUnresolvedAt > 48 * 3_600_000) {
    out.push({
      severity: "WARNING",
      domain: "RESOLVER",
      code: "UNRESOLVED_BACKLOG",
      message: `${input.unresolvedCount} signals await resolution, oldest over 48h.`,
      evidence: `unresolved=${input.unresolvedCount}`,
    });
  }
  if (input.marketProbeOk === false) {
    out.push({
      severity: "WARNING",
      domain: "DATA",
      code: "MARKET_DATA_UNREACHABLE",
      message: "Hyperliquid market data is unreachable from the tester.",
      evidence: "candle probe failed",
    });
  }
  if (
    input.totalSignals > 0 &&
    input.priorSignals > 0 &&
    input.recentSignals < input.priorSignals * 0.3 &&
    cronAge !== null &&
    cronAge <= CRON_WARN_MS
  ) {
    out.push({
      severity: "WATCH",
      domain: "STRATEGY",
      code: "VOLUME_DROP",
      message: `Signal volume dropped sharply (recent ${input.recentSignals} vs prior ${input.priorSignals}) with a healthy cron.`,
      evidence: `recent=${input.recentSignals} prior=${input.priorSignals}`,
    });
  }
  const order: Record<AlertSeverity, number> = { CRITICAL: 0, WARNING: 1, WATCH: 2 };
  return out.sort((a, b) => order[a.severity] - order[b.severity]);
}

/** Overall status: CRITICAL dominates; tiny samples suspend measurement. */
export function classifyQualityStatus(alerts: QualityAlert[], completed: number): QualityStatus {
  if (alerts.some((a) => a.severity === "CRITICAL")) return "CRITICAL";
  if (completed < 20) return "INSUFFICIENT_DATA";
  if (alerts.some((a) => a.severity === "WARNING")) return "WARNING";
  if (alerts.some((a) => a.severity === "WATCH")) return "WATCH";
  return "HEALTHY";
}

export const NO_OVERFIT_TEXT =
  "Correlation is not proof of causation. A small sample must not be used to change strategy parameters. " +
  "Do not optimize based on a single symbol, week, or score bucket. Do not continuously tune the strategy " +
  "to historical outcomes. Measure first. Do not optimize first.";

export interface QualitySnapshot {
  at: number;
  windowDays: number;
  completed: number;
  winRate: number;
  profitFactor: number;
  expectancy: number;
  averageR: number;
  totalR: number;
  noFillRate: number;
  invalidatedRate: number;
  ambiguousRate: number;
  activated: number;
}

/** Windowed snapshot for 7/30/90-day trend comparison (90d bounded by retention). */
export function snapshotWindow(rows: ResolvedSignal[], windowDays: number, now: number): QualitySnapshot {
  const cutoff = now - windowDays * 86_400_000;
  const scoped = rows.filter((r) => r.firstSeen >= cutoff);
  const stats = computePerformanceStats(scoped);
  const act = scoped.filter(
    (r) => r.verdict === "WIN" || r.verdict === "LOSS" || r.verdict === "BREAKEVEN" || r.verdict === "EXPIRED",
  );
  return {
    at: now,
    windowDays,
    completed: stats.completed,
    winRate: stats.winRate,
    profitFactor: stats.profitFactor === Infinity ? -1 : stats.profitFactor,
    expectancy: stats.expectancy,
    averageR: stats.avgR,
    totalR: stats.cumulativeR.length > 0 ? stats.cumulativeR[stats.cumulativeR.length - 1].cumulativeR : 0,
    noFillRate: scoped.length > 0 ? Math.round((stats.noFill / scoped.length) * 1000) / 10 : 0,
    invalidatedRate: scoped.length > 0 ? Math.round((stats.invalidated / scoped.length) * 1000) / 10 : 0,
    ambiguousRate:
      act.length > 0 ? Math.round((act.filter((r) => r.ambiguous).length / act.length) * 1000) / 10 : 0,
    activated: act.length,
  };
}

/** Markdown renderer for reports/signal-quality.md (pure, tested). */
export function renderQualityMarkdown(input: {
  generatedAt: number;
  periodFrom: number;
  periodTo: number;
  sample: SampleClass;
  completed: number;
  activated: number;
  winRate: number;
  profitFactor: number | string;
  expectancy: number;
  averageR: number;
  totalR: number;
  noFill: number;
  invalidated: number;
  expired: number;
  byDirection: { key: string; signals: number; winRate: number; avgR: number }[];
  byEntry: { key: string; signals: number; winRate: number; avgR: number }[];
  byCategory: { key: string; signals: number; winRate: number; avgR: number; profitFactor: number | string }[];
  bestBand: string;
  worstBand: string;
  topSymbols: string[];
  worstSymbols: string[];
  alerts: QualityAlert[];
  snapshots: QualitySnapshot[];
  infraNote: string;
  status: QualityStatus;
}): string {
  const d = (ms: number): string => new Date(ms).toISOString().slice(0, 16).replace("T", " ");
  const L = [
    "SIGNAL QUALITY REPORT",
    "",
    `Generated: ${d(input.generatedAt)} UTC`,
    `Data period: ${d(input.periodFrom)} → ${d(input.periodTo)} UTC`,
    `Completed trades: ${input.completed}`,
    `Activated trades: ${input.activated}`,
    `Sample classification: ${input.sample}`,
    "",
    `Win rate: ${input.winRate}%`,
    `Profit factor: ${input.profitFactor}`,
    `Expectancy: ${input.expectancy}R`,
    `Average R: ${input.averageR}R`,
    `Total R: ${input.totalR}R`,
    "",
    `NO_FILL: ${input.noFill}`,
    `INVALIDATED: ${input.invalidated}`,
    `EXPIRED: ${input.expired}`,
    "",
    ...input.byDirection.map((g) => `${g.key}: n=${g.signals} wr=${g.winRate}% avgR=${g.avgR}R`),
    "",
    ...input.byEntry.map((g) => `${g.key}: n=${g.signals} wr=${g.winRate}% avgR=${g.avgR}R`),
    "",
    ...input.byCategory.map((g) => `${g.key}: n=${g.signals} wr=${g.winRate}% avgR=${g.avgR}R pf=${g.profitFactor}`),
    "",
    `Top-performing score bucket: ${input.bestBand}`,
    `Worst-performing score bucket: ${input.worstBand}`,
    "",
    `Top symbols: ${input.topSymbols.join(", ") || "—"}`,
    `Worst symbols: ${input.worstSymbols.join(", ") || "—"}`,
    "",
    "Detected problems:",
    ...(input.alerts.length > 0
      ? input.alerts.map((a) => `- [${a.severity}/${a.domain}] ${a.code}: ${a.message} (${a.evidence})`)
      : ["- none"]),
    "",
    "Snapshots (7/30/90d windows, 90d bounded by 30-day retention):",
    ...input.snapshots.map(
      (s) =>
        `- ${s.windowDays}d: n=${s.completed} wr=${s.winRate}% pf=${s.profitFactor} exp=${s.expectancy}R avgR=${s.averageR}R totalR=${s.totalR}R noFill=${s.noFillRate}% inv=${s.invalidatedRate}% amb=${s.ambiguousRate}%`,
    ),
    "",
    `Infrastructure: ${input.infraNote}`,
    "",
    `Overall status: ${input.status}`,
    "",
    NO_OVERFIT_TEXT,
  ];
  return L.join("\n");
}

// Re-export for dashboard convenience (single analytics import surface).
export { scoreBand };
