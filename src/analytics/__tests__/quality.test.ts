import { describe, expect, it } from "vitest";
import {
  classifyQualityStatus,
  classifySample,
  computeExtendedMetrics,
  detectInfraProblems,
  detectStrategyProblems,
  NO_OVERFIT_TEXT,
  qualityBand,
  renderQualityMarkdown,
  snapshotWindow,
  type QualityAlert,
} from "../quality";
import { computePerformanceStats } from "../performance";
import type { ResolvedSignal } from "../performance";

const T0 = 1_700_000_000_000;
const H = 3_600_000;

let seq = 0;
function row(over: Partial<ResolvedSignal> = {}): ResolvedSignal {
  seq += 1;
  return {
    id: `t${seq}`,
    symbol: "BTC",
    category: "crypto",
    direction: "LONG",
    timeframe: "15m",
    score: 80,
    firstSeen: T0,
    entryMid: 100,
    verdict: "WIN",
    realizedR: 1,
    exitPrice: 105,
    outcomeAt: T0 + H,
    decidedBy: "TP1→TP2→TP3",
    activationPrice: 100,
    activationTs: T0,
    ambiguous: false,
    setupType: "TREND",
    quality: "MEDIUM QUALITY",
    entryLow: 99,
    entryHigh: 101,
    invalidation: 95,
    tp1: 105,
    tp2: 110,
    tp3: 115,
    riskReward: 2,
    entryType: "MARKET",
    lastSeen: T0 + H,
    resolvedAt: T0 + H,
    reasons: [],
    ...over,
  };
}

describe("classifySample", () => {
  it("gates conclusions by completed count", () => {
    expect(classifySample(0)).toBe("INSUFFICIENT_DATA");
    expect(classifySample(19)).toBe("INSUFFICIENT_DATA");
    expect(classifySample(20)).toBe("EARLY");
    expect(classifySample(49)).toBe("EARLY");
    expect(classifySample(50)).toBe("DEVELOPING");
    expect(classifySample(99)).toBe("DEVELOPING");
    expect(classifySample(100)).toBe("MEANINGFUL");
  });
});

describe("qualityBand", () => {
  it("buckets per spec", () => {
    expect(qualityBand(95)).toBe("90+");
    expect(qualityBand(85)).toBe("85–89");
    expect(qualityBand(80)).toBe("80–84");
    expect(qualityBand(75)).toBe("75–79");
    expect(qualityBand(70)).toBe("70–74");
    expect(qualityBand(69)).toBe("<70");
  });
});

describe("computeExtendedMetrics", () => {
  it("computes median, streaks, TP behavior and ambiguity rates", () => {
    const rows = [
      row({ verdict: "WIN", realizedR: 2, outcomeAt: T0 + H }),
      row({ verdict: "WIN", realizedR: 1, outcomeAt: T0 + 2 * H, decidedBy: "TP1→TP2→STOP" }),
      row({ verdict: "LOSS", realizedR: -1, outcomeAt: T0 + 3 * H, decidedBy: "STOP", ambiguous: true }),
      row({ verdict: "LOSS", realizedR: -1, outcomeAt: T0 + 4 * H, decidedBy: "STOP" }),
      row({ verdict: "BREAKEVEN", realizedR: 0, outcomeAt: T0 + 5 * H, decidedBy: "TP1→STOP" }),
      row({ verdict: "NO_FILL", realizedR: null, outcomeAt: null }),
    ];
    const ext = computeExtendedMetrics(rows);
    expect(ext.medianR).toBe(0);
    expect(ext.maxWinStreak).toBe(2);
    expect(ext.maxLossStreak).toBe(2);
    expect(ext.tp1Rate).toBe(60); // 3 of 5 activated touch TP1
    expect(ext.tp2Rate).toBe(40);
    expect(ext.tp3Rate).toBe(20);
    expect(ext.ambiguousRate).toBe(20);
    expect(ext.noFillRate).toBe(16.67);
    expect(ext.byScore5.find((g) => g.key === "80–84")?.signals).toBe(5);
  });

  it("never mutates inputs", () => {
    const rows = [row(), row({ verdict: "LOSS", realizedR: -1 })];
    const before = JSON.stringify(rows);
    computeExtendedMetrics(rows);
    expect(JSON.stringify(rows)).toBe(before);
  });
});

describe("detectStrategyProblems", () => {
  it("stays silent below sample gates", () => {
    const rows = [row({ verdict: "LOSS", realizedR: -5 })];
    const stats = computePerformanceStats(rows);
    const alerts = detectStrategyProblems({ stats, ext: computeExtendedMetrics(rows), rows });
    // n=1: no strong conclusions even with terrible numbers.
    expect(alerts.filter((a) => a.severity !== "WATCH")).toEqual([]);
  });

  it("flags score inversion with sufficient samples", () => {
    const rows: ResolvedSignal[] = [];
    for (let i = 0; i < 10; i++) rows.push(row({ score: 92, verdict: "LOSS", realizedR: -1, outcomeAt: T0 + i * H }));
    for (let i = 0; i < 10; i++) rows.push(row({ score: 71, verdict: "WIN", realizedR: 1, outcomeAt: T0 + (10 + i) * H }));
    const stats = computePerformanceStats(rows);
    const codes = detectStrategyProblems({ stats, ext: computeExtendedMetrics(rows), rows }).map((a) => a.code);
    expect(codes).toContain("SCORE_INVERSION");
  });

  it("flags sub-1 profit factor and negative expectancy at n>=20", () => {
    const rows: ResolvedSignal[] = [];
    for (let i = 0; i < 14; i++) rows.push(row({ verdict: "LOSS", realizedR: -1, outcomeAt: T0 + i * H }));
    for (let i = 0; i < 6; i++) rows.push(row({ verdict: "WIN", realizedR: 1, outcomeAt: T0 + (14 + i) * H }));
    const stats = computePerformanceStats(rows);
    const codes = detectStrategyProblems({ stats, ext: computeExtendedMetrics(rows), rows }).map((a) => a.code);
    expect(codes).toContain("PF_BELOW_ONE");
    expect(codes).toContain("EXPECTANCY_NEGATIVE");
  });

  it("flags extreme NO_FILL rates", () => {
    const rows: ResolvedSignal[] = [];
    for (let i = 0; i < 12; i++) rows.push(row({ verdict: "NO_FILL", realizedR: null, outcomeAt: null }));
    for (let i = 0; i < 8; i++) rows.push(row({ outcomeAt: T0 + i * H }));
    const stats = computePerformanceStats(rows);
    const codes = detectStrategyProblems({ stats, ext: computeExtendedMetrics(rows), rows }).map((a) => a.code);
    expect(codes).toContain("RETEST_NO_FILL_HIGH");
  });
});

describe("detectInfraProblems", () => {
  const now = T0 + 10 * H;
  const healthy = {
    now,
    cronLastRunAt: now - 4 * 60_000,
    resolverAt: now - 10 * 60_000,
    unresolvedCount: 3,
    oldestUnresolvedAt: now - H,
    totalSignals: 50,
    lastSignalAt: now - H,
    dbError: null as string | null,
    marketProbeOk: true as boolean | null,
    recentSignals: 20,
    priorSignals: 22,
  };

  it("reports healthy infra with no alerts", () => {
    expect(detectInfraProblems(healthy)).toEqual([]);
  });

  it("never blames the strategy for missing data (CRON vs strategy)", () => {
    const alerts = detectInfraProblems({ ...healthy, cronLastRunAt: now - 90 * 60_000, recentSignals: 0, priorSignals: 0, totalSignals: 0 });
    expect(alerts.some((a) => a.code === "CRON_STALE" && a.severity === "CRITICAL")).toBe(true);
    expect(alerts.some((a) => a.domain === "STRATEGY")).toBe(false);
  });

  it("escalates database failures as CRITICAL DATABASE problems", () => {
    const alerts = detectInfraProblems({ ...healthy, dbError: "connection refused" });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ severity: "CRITICAL", domain: "DATABASE", code: "DB_UNREADABLE" });
  });

  it("flags stale resolvers, backlogs and dead market probes", () => {
    const alerts = detectInfraProblems({
      ...healthy,
      resolverAt: now - 200 * 60_000,
      unresolvedCount: 80,
      oldestUnresolvedAt: now - 50 * 3_600_000,
      marketProbeOk: false,
    });
    const codes = alerts.map((a) => a.code);
    expect(codes).toContain("RESOLVER_STALE");
    expect(codes).toContain("UNRESOLVED_BACKLOG");
    expect(codes).toContain("MARKET_DATA_UNREACHABLE");
  });

  it("flags volume drops only when the cron is healthy", () => {
    const drop = detectInfraProblems({ ...healthy, recentSignals: 2, priorSignals: 20 });
    expect(drop.map((a) => a.code)).toContain("VOLUME_DROP");
    const stale = detectInfraProblems({ ...healthy, recentSignals: 2, priorSignals: 20, cronLastRunAt: now - 90 * 60_000 });
    expect(stale.map((a) => a.code)).not.toContain("VOLUME_DROP");
  });

  it("reports CRON_MISSING and RESOLVER_MISSING distinctly from delayed", () => {
    // Null heartbeat (no row ever written) is MISSING, not merely delayed.
    const missing = detectInfraProblems({ ...healthy, cronLastRunAt: null, resolverAt: null });
    const codes = missing.map((a) => a.code);
    expect(codes).toContain("CRON_MISSING");
    expect(codes).toContain("RESOLVER_MISSING");
    expect(codes).not.toContain("CRON_DELAYED");
    expect(codes).not.toContain("CRON_STALE");
    expect(codes).not.toContain("RESOLVER_DELAYED");
    expect(codes).not.toContain("RESOLVER_STALE");
    expect(missing.find((a) => a.code === "CRON_MISSING")?.severity).toBe("WARNING");
    expect(missing.find((a) => a.code === "RESOLVER_MISSING")?.severity).toBe("WARNING");
  });
});

describe("classifyQualityStatus", () => {
  it("orders CRITICAL > INSUFFICIENT_DATA > WARNING > WATCH > HEALTHY", () => {
    const crit: QualityAlert[] = [{ severity: "CRITICAL", domain: "CRON", code: "X", message: "x", evidence: "x" }];
    const warn: QualityAlert[] = [{ severity: "WARNING", domain: "STRATEGY", code: "X", message: "x", evidence: "x" }];
    expect(classifyQualityStatus(crit, 200)).toBe("CRITICAL");
    expect(classifyQualityStatus(crit, 0)).toBe("CRITICAL");
    expect(classifyQualityStatus([], 5)).toBe("INSUFFICIENT_DATA");
    expect(classifyQualityStatus(warn, 50)).toBe("WARNING");
    expect(classifyQualityStatus([], 200)).toBe("HEALTHY");
  });
});

describe("renderQualityMarkdown + no-overfit guard", () => {
  it("renders the full report skeleton with all required sections", () => {
    const rows = [row(), row({ verdict: "LOSS", realizedR: -1 })];
    const stats = computePerformanceStats(rows);
    const ext = computeExtendedMetrics(rows);
    const md = renderQualityMarkdown({
      generatedAt: T0,
      periodFrom: T0 - 30 * 86_400_000,
      periodTo: T0,
      sample: classifySample(stats.completed),
      completed: stats.completed,
      activated: stats.wins + stats.losses,
      winRate: stats.winRate,
      profitFactor: stats.profitFactor,
      expectancy: stats.expectancy,
      averageR: stats.avgR,
      totalR: 1,
      noFill: stats.noFill,
      invalidated: stats.invalidated,
      expired: stats.expired,
      byDirection: stats.byDirection,
      byEntry: ext.byEntry,
      byCategory: stats.byCategory,
      bestBand: "80–84",
      worstBand: "<70",
      topSymbols: ["BTC"],
      worstSymbols: ["ETH"],
      alerts: [],
      snapshots: [snapshotWindow(rows, 7, T0)],
      infraNote: "cron healthy",
      status: "INSUFFICIENT_DATA",
    });
    for (const needle of [
      "SIGNAL QUALITY REPORT", "Completed trades:", "Activated trades:", "Sample classification:",
      "Win rate:", "Profit factor:", "Expectancy:", "Average R:", "Total R:",
      "NO_FILL:", "INVALIDATED:", "EXPIRED:", "Top-performing score bucket:",
      "Top symbols:", "Detected problems:", "Overall status:",
      "Correlation is not proof of causation",
    ]) {
      expect(md).toContain(needle);
    }
  });

  it("exposes the no-overfit warning text", () => {
    expect(NO_OVERFIT_TEXT).toMatch(/Do not optimize/);
    expect(NO_OVERFIT_TEXT).toMatch(/Measure first/);
  });
});
