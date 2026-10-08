/**
 * Continuous signal-quality testing (headless, read-only).
 *
 * Live mode (daily): reads resolved signal history + heartbeats, computes
 * extended metrics, evaluates strategy/infra alert rules with sample
 * gates, and writes reports/signal-quality.json|.md (+ issue.json and
 * telegram.txt only when warranted).
 *
 * Infra mode (every 6h): heartbeats, unresolved backlog, market-data probe
 * and DB readability only — fast, no full analytics pass.
 *
 * SAFETY: this script NEVER imports the strategy (analysis/signal,
 * scanner/engine), NEVER writes to any table (GET reads only), NEVER calls
 * AI, and NEVER tunes anything. It detects and reports. A raw-source guard
 * test pins these properties.
 *
 * Env (server-side only, never VITE_*):
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (always required)
 *   TELEGRAM_BOT_TOKEN (only with --telegram)
 * Usage:
 *   tsx scripts/signal-quality-test.ts [--mode=live|infra] [--out=reports] [--telegram]
 * Exit: 0 ran (status inside the report), 1 CRITICAL status, 2 usage/env error.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getCandles } from "../src/market/hyperliquid/candles.js";
import { createSupabaseStateStore } from "../src/cron/state.js";
import { listEnabledChats } from "../src/cron/chats.js";
import { createTelegramSender } from "../src/cron/notify.js";
import { mapResolvedRow, type ResolvedRow } from "../src/analytics/resolved.js";
import {
  classifyQualityStatus,
  classifySample,
  computeExtendedMetrics,
  detectInfraProblems,
  detectStrategyProblems,
  NO_OVERFIT_TEXT,
  renderQualityMarkdown,
  snapshotWindow,
  type QualityAlert,
  type QualityStatus,
} from "../src/analytics/quality.js";
import { computePerformanceStats } from "../src/analytics/performance.js";

function usage(): never {
  console.error("Usage: tsx scripts/signal-quality-test.ts [--mode=live|infra] [--out=reports] [--telegram]");
  process.exit(2);
}

function arg(name: string, def?: string): string | undefined {
  const hit = process.argv.find((a) => a === name || a.startsWith(`${name}=`));
  if (!hit) return def;
  const eq = hit.indexOf("=");
  return eq === -1 ? "1" : hit.slice(eq + 1);
}

function required(name: string): string {
  const v = (process.env[name] ?? "").trim();
  if (!v) {
    console.error(`Missing required env ${name}.`);
    process.exit(2);
  }
  return v;
}

interface RestOut {
  status: number;
  json: unknown;
  contentRange: string | null;
}

async function rest(
  base: string,
  headers: Record<string, string>,
  path: string,
  init?: RequestInit,
  timeoutMs = 30_000,
): Promise<RestOut> {
  const res = await fetch(`${base}/rest/v1/${path}`, {
    ...init,
    headers: { ...headers, ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(timeoutMs),
  });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    // ignore body read failures
  }
  return { status: res.status, json, contentRange: res.headers.get("content-range") };
}

function countOf(range: string | null): number | null {
  if (!range) return null;
  const m = /\/(\d+)\s*$/.exec(range);
  return m ? Number.parseInt(m[1], 10) : null;
}

async function main(): Promise<void> {
  const mode = arg("--mode", "live");
  if (mode !== "live" && mode !== "infra") usage();
  const outDir = arg("--out", "reports") ?? "reports";
  const wantTelegram = process.argv.includes("--telegram");
  const log = (msg: string) => console.log(`[signal-quality] ${msg}`);

  const supabaseUrl = required("SUPABASE_URL").replace(/\/$/, "");
  const serviceKey = required("SUPABASE_SERVICE_ROLE_KEY");
  let botToken = "";
  if (wantTelegram) botToken = required("TELEGRAM_BOT_TOKEN");

  const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };
  const now = Date.now();
  const alerts: QualityAlert[] = [];
  let dbError: string | null = null;

  // ---- Heartbeats (both modes) ----
  let cronAt: number | null = null;
  let resolverAt: number | null = null;
  let resolverChecked = 0;
  let resolverResolved = 0;
  try {
    const store = createSupabaseStateStore({ url: supabaseUrl, serviceKey });
    const cron = (await store.loadValue("cron-monitor")) as {
      lastRun?: { at?: unknown; lastDeliveryAt?: unknown };
    } | null;
    if (cron && typeof cron.lastRun?.at === "number") cronAt = cron.lastRun.at;
    const reso = (await store.loadValue("resolve-outcomes")) as {
      at?: unknown;
      checked?: unknown;
      resolved?: unknown;
    } | null;
    if (reso && typeof reso.at === "number") {
      resolverAt = reso.at;
      resolverChecked = typeof reso.checked === "number" ? reso.checked : 0;
      resolverResolved = typeof reso.resolved === "number" ? reso.resolved : 0;
    }
  } catch (e) {
    dbError = e instanceof Error ? e.message : "heartbeat read failed";
  }

  // ---- Unresolved backlog + volume windows (both modes, exact counts) ----
  let total: number | null = null;
  let unresolved = 0;
  let oldestUnresolved: number | null = null;
  let recent = 0;
  let prior = 0;
  if (!dbError) {
    try {
      const week = now - 7 * 86_400_000;
      const twoWeeks = now - 14 * 86_400_000;
      const iso = (ms: number): string => new Date(ms).toISOString();
      const t = await rest(supabaseUrl, headers, `signal_history?select=id`, {
        headers: { Prefer: "count=exact" },
      });
      total = countOf(t.contentRange);
      const u = await rest(supabaseUrl, headers, `signal_history?outcome=is.null&select=id`, {
        headers: { Prefer: "count=exact" },
      });
      unresolved = countOf(u.contentRange) ?? 0;
      const oldest = await rest(
        supabaseUrl,
        headers,
        `signal_history?outcome=is.null&select=first_seen&order=first_seen.asc&limit=1`,
      );
      if (oldest.status === 200 && Array.isArray(oldest.json) && oldest.json.length > 0) {
        const ts = Date.parse(String((oldest.json[0] as { first_seen?: unknown }).first_seen ?? ""));
        if (Number.isFinite(ts)) oldestUnresolved = ts;
      }
      const r = await rest(
        supabaseUrl,
        headers,
        `signal_history?first_seen=gte.${encodeURIComponent(iso(week))}&select=id`,
        { headers: { Prefer: "count=exact" } },
      );
      recent = countOf(r.contentRange) ?? 0;
      const p = await rest(
        supabaseUrl,
        headers,
        `signal_history?first_seen=gte.${encodeURIComponent(iso(twoWeeks))}&first_seen=lt.${encodeURIComponent(iso(week))}&select=id`,
        { headers: { Prefer: "count=exact" } },
      );
      prior = countOf(p.contentRange) ?? 0;
      if (t.status !== 200) throw new Error(`history count failed (HTTP ${t.status})`);
    } catch (e) {
      dbError = e instanceof Error ? e.message : "count queries failed";
    }
  }

  // ---- Market-data probe (both modes, one lightweight call) ----
  let probeOk: boolean | null = null;
  try {
    const end = now;
    const candles = await getCandles("BTC", "15m", end - 2 * 15 * 60_000, end, { timeoutMs: 15_000 });
    probeOk = candles.length > 0;
  } catch {
    probeOk = false;
  }

  // ---- Resolved rows (live mode only) ----
  type Row = ReturnType<typeof mapResolvedRow>;
  let rows: NonNullable<Row>[] = [];
  let capped = false;
  if (mode === "live" && !dbError) {
    try {
      const res = await rest(supabaseUrl, headers, `signal_history?select=*&order=first_seen.asc&limit=2000`, undefined, 60_000);
      if (res.status !== 200 || !Array.isArray(res.json)) throw new Error(`history read failed (HTTP ${res.status})`);
      const raw = res.json as ResolvedRow[];
      capped = raw.length >= 2000;
      for (const r of raw) {
        const m = mapResolvedRow(r);
        if (m) rows.push(m);
      }
    } catch (e) {
      dbError = e instanceof Error ? e.message : "history read failed";
      rows = [];
    }
  }

  // ---- Analysis ----
  const stats = computePerformanceStats(rows);
  const ext = computeExtendedMetrics(rows);
  const strategyAlerts = mode === "live" && !dbError ? detectStrategyProblems({ stats, ext, rows }) : [];
  const infraAlerts = detectInfraProblems({
    now,
    cronLastRunAt: cronAt,
    resolverAt,
    unresolvedCount: unresolved,
    oldestUnresolvedAt: oldestUnresolved,
    totalSignals: total ?? 0,
    lastSignalAt: null,
    dbError,
    marketProbeOk: probeOk,
    recentSignals: recent,
    priorSignals: prior,
  });
  const alertsAll = [...infraAlerts, ...strategyAlerts];
  const status: QualityStatus = classifyQualityStatus(alertsAll, mode === "live" ? stats.completed : 0);
  const sample = classifySample(stats.completed);

  const snapshots = [7, 30, 90].map((d) => snapshotWindow(rows, d, now));
  const byScore = ext.byScore5;
  const ranked = [...byScore].filter((g) => g.signals > 0).sort((a, b) => b.avgR - a.avgR);
  const syms = [...stats.bySymbol].sort((a, b) => b.cumulativeR - a.cumulativeR);

  const pfText = stats.profitFactor === Infinity ? "∞" : stats.profitFactor;
  const md = renderQualityMarkdown({
    generatedAt: now,
    periodFrom: rows.length > 0 ? Math.min(...rows.map((r) => r.firstSeen)) : now,
    periodTo: now,
    sample,
    completed: stats.completed,
    activated: stats.wins + stats.losses + stats.breakeven,
    winRate: stats.winRate,
    profitFactor: pfText,
    expectancy: stats.expectancy,
    averageR: stats.avgR,
    totalR: stats.cumulativeR.length > 0 ? stats.cumulativeR[stats.cumulativeR.length - 1].cumulativeR : 0,
    noFill: stats.noFill,
    invalidated: stats.invalidated,
    expired: stats.expired,
    byDirection: stats.byDirection,
    byEntry: ext.byEntry,
    byCategory: stats.byCategory,
    bestBand: ranked.length > 0 ? `${ranked[0].key} → ${ranked[0].avgR}R` : "—",
    worstBand: ranked.length > 0 ? `${ranked[ranked.length - 1].key} → ${ranked[ranked.length - 1].avgR}R` : "—",
    topSymbols: syms.slice(0, 3).map((g) => `${g.key} (${g.cumulativeR}R, n=${g.signals})`),
    worstSymbols: syms.slice(-3).reverse().map((g) => `${g.key} (${g.cumulativeR}R, n=${g.signals})`),
    alerts: alertsAll,
    snapshots,
    infraNote:
      `mode=${mode}; cron=${cronAt ? new Date(cronAt).toISOString() : "never"}; ` +
      `resolver=${resolverAt ? new Date(resolverAt).toISOString() : "never"} ` +
      `(checked=${resolverChecked} resolved=${resolverResolved}); unresolved=${unresolved}; ` +
      `probe=${probeOk === null ? "n/a" : probeOk ? "ok" : "failed"}` +
      (capped ? "; ROW CAP 2000 HIT (widen or paginate for full history)" : "") +
      "; retention 30d bounds 90d windows",
    status,
  });

  const report = {
    generatedAt: new Date(now).toISOString(),
    mode,
    status,
    sample,
    completed: stats.completed,
    metrics: {
      winRate: stats.winRate,
      profitFactor: stats.profitFactor === Infinity ? "Infinity" : stats.profitFactor,
      expectancy: stats.expectancy,
      averageR: stats.avgR,
      medianR: ext.medianR,
      maxWinStreak: ext.maxWinStreak,
      maxLossStreak: ext.maxLossStreak,
      noFill: stats.noFill,
      invalidated: stats.invalidated,
      expired: stats.expired,
      ambiguous: stats.ambiguous,
    },
    breakdowns: {
      byScore5: ext.byScore5,
      byDirection: stats.byDirection,
      byEntry: ext.byEntry,
      byCategory: stats.byCategory,
      byTimeframe: stats.byTimeframe,
      bySymbol: stats.bySymbol,
      bySetup: ext.bySetup,
      byQuality: ext.byQuality,
      tp: { tp1Rate: ext.tp1Rate, tp2Rate: ext.tp2Rate, tp3Rate: ext.tp3Rate },
    },
    alerts: alertsAll,
    snapshots,
    infra: {
      cronLastRunAt: cronAt ? new Date(cronAt).toISOString() : null,
      resolverAt: resolverAt ? new Date(resolverAt).toISOString() : null,
      resolverChecked,
      resolverResolved,
      unresolved,
      oldestUnresolvedAt: oldestUnresolved ? new Date(oldestUnresolved).toISOString() : null,
      totalSignals: total,
      recent7d: recent,
      prior7d: prior,
      marketProbeOk: probeOk,
      dbError,
    },
    notes: [
      "Retention: cron prunes signal_history older than 30 days, so 90d windows are bounded.",
      "Legacy rows without entry types measure immediately (no retroactive methodology change).",
      NO_OVERFIT_TEXT,
    ],
  };

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "signal-quality.json"), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(join(outDir, "signal-quality.md"), `${md}\n`);
  log(`status=${status} completed=${stats.completed} alerts=${alertsAll.length} → ${outDir}/`);

  // ---- Issue hook (workflow creates it via gh; runner only drafts) ----
  const qualifies =
    status === "CRITICAL" || (alertsAll.some((a) => a.severity === "WARNING") && stats.completed >= 50);
  const issueAlerts = alertsAll.filter((a) => a.severity !== "WATCH");
  if (qualifies && issueAlerts.length > 0) {
    const signature = [...new Set(issueAlerts.map((a) => a.code))].sort().join("+");
    const worst = issueAlerts[0];
    const body = [
      "Signal Quality Regression",
      "",
      `Severity: ${worst.severity}`,
      `Detected: ${new Date(now).toISOString()}`,
      `Sample size: ${stats.completed} completed`,
      "",
      `Problem: ${worst.message}`,
      `Evidence: ${worst.evidence}`,
      "",
      "Affected category: see evidence lines above",
      "Affected timeframe: see report",
      "Affected symbols: see report",
      "",
      "Metrics:",
      `winRate=${stats.winRate}% pf=${pfText} expectancy=${stats.expectancy}R avgR=${stats.avgR}R`,
      "",
      "Likely cause: see evidence lines above (infra alerts take precedence over strategy alerts)",
      "",
      "Recommended investigation: check the cited heartbeat/job, then the evidence query in SQL Editor.",
      "",
      "NO AUTOMATIC STRATEGY CHANGE PERFORMED.",
    ].join("\n");
    writeFileSync(
      join(outDir, "issue.json"),
      `${JSON.stringify(
        { title: `Signal Quality Regression [${signature}]`, body, labels: ["signal-quality", worst.severity.toLowerCase()], signature },
        null,
        2,
      )}\n`,
    );
    log(`issue drafted [${signature}]`);
  }

  // ---- Telegram hook (CRITICAL infra/data only, never statistical noise) ----
  const criticalInfra = alertsAll.filter(
    (a) => a.severity === "CRITICAL" && (a.domain === "CRON" || a.domain === "RESOLVER" || a.domain === "DATABASE" || a.domain === "DATA"),
  );
  if (wantTelegram && criticalInfra.length > 0) {
    const first = criticalInfra[0];
    const text = [
      "🚨 SIGNAL SYSTEM ALERT",
      "",
      "Status: CRITICAL",
      "",
      `Problem: ${first.message}`,
      "",
      "Signals:",
      `${total ?? 0}`,
      "",
      "Unresolved:",
      `${unresolved}`,
      "",
      `Last successful resolver: ${resolverAt ? new Date(resolverAt).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "never reported"}`,
      "",
      "No strategy changes were made.",
    ].join("\n");
    writeFileSync(join(outDir, "telegram.txt"), `${text}\n`);
    try {
      const chats = await listEnabledChats({ url: supabaseUrl, serviceKey });
      const sender = createTelegramSender({ token: botToken });
      let sent = 0;
      for (const chat of chats) {
        const r = await sender.send(chat, text, null);
        if (r.ok) sent += 1;
      }
      log(`telegram alert → ${sent}/${chats.length} chats`);
    } catch (e) {
      log(`telegram alert FAILED: ${e instanceof Error ? e.message : "unknown"} (report unaffected)`);
    }
  }

  if (status === "CRITICAL") process.exit(1);
}

main().catch((e: unknown) => {
  console.error(`[signal-quality] fatal: ${e instanceof Error ? e.message : "unknown"}`);
  process.exit(2);
});
