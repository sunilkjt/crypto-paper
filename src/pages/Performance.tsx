import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Search } from "lucide-react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Card, CardHeader, PageHeader } from "../components/ui";
import { CategoryChip, FilterGroup } from "../components/SignalCard";
import { ConnectionBadge } from "../components/ConnectionBadge";
import { useAuth } from "../supabase/auth";
import { getSupabase } from "../supabase/client";
import { useScannerHealth } from "../supabase/history";
import { useMarkets } from "../market/store";
import { getSharedPaperEngine, realizedR } from "../paper";
import {
  MIN_SAMPLE_WARNING,
  applyPerformanceFilters,
  computePerformanceStats,
  type DateRange,
  type GroupStats,
  type PerformanceFilters,
  type ResolvedSignal,
} from "../analytics/performance";
import {
  classifyQualityStatus,
  classifySample,
  computeExtendedMetrics,
  detectInfraProblems,
  detectStrategyProblems,
  snapshotWindow,
  type QualityStatus,
} from "../analytics/quality";
import { fetchResolvedSignals } from "../analytics/resolved";
import { SignalDetailsModal } from "../components/SignalDetails";
import { cn } from "../lib/cn";

type SymbolSort = "totalR" | "winRate" | "avgR" | "signals";

const RANGE_OPTIONS: { value: DateRange; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "all", label: "All time" },
];

function fmtR(v: number): string {
  return `${v >= 0 ? "+" : ""}${v.toFixed(2)}R`;
}

function fmtPF(v: number): string {
  return v === Infinity ? "∞" : v.toFixed(2);
}

function fmtAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

const STATUS_META: Record<QualityStatus, { emoji: string; chip: string }> = {
  HEALTHY: { emoji: "🟢", chip: "border-emerald-400/30 bg-emerald-400/10 text-emerald-300" },
  WATCH: { emoji: "🟡", chip: "border-amber-400/30 bg-amber-400/10 text-amber-300" },
  WARNING: { emoji: "🟠", chip: "border-orange-400/30 bg-orange-400/10 text-orange-300" },
  CRITICAL: { emoji: "🔴", chip: "border-rose-400/30 bg-rose-400/10 text-rose-300" },
  INSUFFICIENT_DATA: { emoji: "⚪", chip: "border-slate-700 bg-slate-800 text-slate-400" },
};

/**
 * Signal Quality Monitor: continuous-measurement summary over the FULL
 * server history (unfiltered) plus live cron/resolver heartbeats. No
 * tuning, no thresholds changed here — detection display only.
 */
function QualityMonitor({ rows }: { rows: ResolvedSignal[] }) {
  const { health } = useScannerHealth(true);
  const m = useMemo(() => {
    const now = Date.now();
    const all = computePerformanceStats(rows);
    const ext = computeExtendedMetrics(rows);
    const openRows = rows.filter((r) => r.verdict === "OPEN");
    const week = now - 7 * 86_400_000;
    const twoWeeks = now - 14 * 86_400_000;
    const infra = detectInfraProblems({
      now,
      cronLastRunAt: health?.lastRunAt ?? null,
      resolverAt: health?.resolver?.at ?? null,
      unresolvedCount: openRows.length,
      oldestUnresolvedAt: openRows.length > 0 ? Math.min(...openRows.map((r) => r.firstSeen)) : null,
      totalSignals: rows.length,
      lastSignalAt: null,
      dbError: null,
      marketProbeOk: null,
      recentSignals: rows.filter((r) => r.firstSeen >= week).length,
      priorSignals: rows.filter((r) => r.firstSeen >= twoWeeks && r.firstSeen < week).length,
    });
    const strategy = detectStrategyProblems({ stats: all, ext, rows });
    const alerts = [...infra, ...strategy];
    return {
      now,
      all,
      ext,
      alerts,
      status: classifyQualityStatus(alerts, all.completed),
      sample: classifySample(all.completed),
      snap7: snapshotWindow(rows, 7, now),
      snap30: snapshotWindow(rows, 30, now),
    };
  }, [rows, health]);
  const meta = STATUS_META[m.status];
  const noFillPct = rows.length > 0 ? ((m.all.noFill / rows.length) * 100).toFixed(1) : "—";
  const invPct = rows.length > 0 ? ((m.all.invalidated / rows.length) * 100).toFixed(1) : "—";
  const actN = m.all.wins + m.all.losses + m.all.breakeven + m.all.expired;
  const ambPct = actN > 0 ? ((m.all.ambiguous / actN) * 100).toFixed(1) : "—";
  return (
    <Card className="mb-4">
      <CardHeader
        title="Signal Quality Monitor"
        subtitle="Continuous measurement over full history + live heartbeats — detection only, never tuning"
        right={
          <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[11px] font-bold", meta.chip)}>
            <span aria-hidden="true">{meta.emoji}</span> {m.status.replace("_", " ")}
          </span>
        }
      />
      <div className="grid grid-cols-2 gap-2.5 p-4 sm:grid-cols-3 lg:grid-cols-6">
        {[
          ["Sample", `${m.sample} (${m.all.completed})`],
          ["Win Rate", `${m.all.winRate.toFixed(1)}%`],
          ["Profit Factor", fmtPF(m.all.profitFactor)],
          ["Expectancy", fmtR(m.all.expectancy)],
          ["Average R", fmtR(m.all.avgR)],
          ["NO_FILL %", `${noFillPct}%`],
          ["Invalidated %", `${invPct}%`],
          ["Ambiguous %", `${ambPct}%`],
          ["Cron Heartbeat", m.now && health?.lastRunAt ? fmtAge(m.now - health.lastRunAt) + " ago" : "never"],
          ["Resolver Heartbeat", health?.resolver ? fmtAge(m.now - health.resolver.at) + " ago" : "never"],
          ["7d avg R", fmtR(m.snap7.averageR)],
          ["30d avg R", fmtR(m.snap30.averageR)],
        ].map(([k, v]) => (
          <div key={k} className="rounded-xl border border-slate-800 bg-slate-950/60 p-3">
            <p className="text-[10px] font-bold tracking-widest text-slate-500 uppercase">{k}</p>
            <p className="mt-1 font-mono text-sm font-bold break-words text-slate-100">{v}</p>
          </div>
        ))}
      </div>
      {m.alerts.length > 0 && (
        <ul className="space-y-1.5 px-4 pb-2 text-xs">
          {m.alerts.slice(0, 6).map((a) => (
            <li key={a.code} className="rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2 text-slate-300">
              <span className="font-bold text-slate-100">[{a.severity}/{a.domain}] {a.code}:</span> {a.message}{" "}
              <span className="font-mono text-[11px] text-slate-500">({a.evidence})</span>
            </li>
          ))}
        </ul>
      )}
      <p className="px-5 py-3 text-[11px] leading-relaxed text-slate-600">
        Correlation is not proof of causation. Small samples must not drive strategy changes — see Methodology.
      </p>
    </Card>
  );
}

function VerdictChip({ verdict }: { verdict: string }) {
  const style =
    verdict === "WIN"
      ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-300"
      : verdict === "LOSS"
        ? "border-rose-400/30 bg-rose-400/10 text-rose-300"
        : verdict === "OPEN"
          ? "border-cyan-400/30 bg-cyan-400/10 text-cyan-300"
          : "border-slate-700 bg-slate-800 text-slate-400";
  return (
    <span className={cn("inline-flex rounded-full border px-2 py-0.5 text-[10px] font-bold tracking-wider", style)}>
      {verdict}
    </span>
  );
}

function GroupTable({ title, subtitle, rows, showSampleHint }: { title: string; subtitle: string; rows: GroupStats[]; showSampleHint?: boolean }) {
  return (
    <Card>
      <CardHeader title={title} subtitle={subtitle} />
      {rows.length === 0 ? (
        <p className="px-5 py-8 text-center text-sm text-slate-500">No completed signals in this group yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-xs" style={{ minWidth: 640 }}>
            <thead>
              <tr className="border-b border-slate-800 text-[10px] tracking-widest text-slate-500 uppercase">
                {["Group", "Signals", "Wins", "Win Rate", "Avg R", "Profit Factor", "Expectancy", "Total R"].map((c) => (
                  <th key={c} className="px-3 py-2.5 font-semibold whitespace-nowrap">{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((g) => (
                <tr key={g.key} className="border-b border-slate-800/50 font-mono last:border-0 hover:bg-slate-900/50">
                  <td className="px-3 py-2 font-sans font-bold text-white">
                    {g.key}
                    {showSampleHint && g.signals < 5 && (
                      <span className="ml-1.5 rounded bg-slate-800 px-1.5 py-0.5 text-[10px] font-bold text-slate-400" title="Very few completed signals — not statistically meaningful">
                        tiny sample
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-slate-300">{g.signals}</td>
                  <td className="px-3 py-2 text-slate-300">{g.wins}</td>
                  <td className="px-3 py-2 text-slate-200">{g.winRate.toFixed(1)}%</td>
                  <td className={cn("px-3 py-2 font-bold", g.avgR > 0 ? "text-emerald-300" : g.avgR < 0 ? "text-rose-300" : "text-slate-300")}>{fmtR(g.avgR)}</td>
                  <td className="px-3 py-2 text-slate-200">{fmtPF(g.profitFactor)}</td>
                  <td className="px-3 py-2 text-slate-200">{fmtR(g.expectancy)}</td>
                  <td className={cn("px-3 py-2 font-bold", g.cumulativeR > 0 ? "text-emerald-300" : g.cumulativeR < 0 ? "text-rose-300" : "text-slate-300")}>{fmtR(g.cumulativeR)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

export default function Performance() {
  const { user, configured } = useAuth();
  const { markets } = useMarkets();
  const mainSymbols = useMemo(
    () => new Set(markets.filter((m) => !m.symbol.includes(":")).map((m) => m.symbol.toUpperCase())),
    [markets],
  );
  const [rows, setRows] = useState<ResolvedSignal[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [category, setCategory] = useState<PerformanceFilters["category"]>("ALL");
  const [direction, setDirection] = useState<PerformanceFilters["direction"]>("ALL");
  const [minScore, setMinScore] = useState(0);
  const [range, setRange] = useState<DateRange>("all");
  const [query, setQuery] = useState("");
  const [symbolSort, setSymbolSort] = useState<SymbolSort>("totalR");
  // Deep-linkable selection: ?signal=<id> opens the details modal; browser
  // back clears the param, which closes the modal (single source of truth).
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedId = searchParams.get("signal");
  const marks = useMemo(() => {
    const m = new Map<string, number>();
    for (const mk of markets) if (mk.markPrice !== null) m.set(mk.symbol, mk.markPrice);
    return m;
  }, [markets]);

  useEffect(() => {
    if (!user) {
      setRows([]);
      setLoading(false);
      return;
    }
    const sb = getSupabase();
    if (!sb) {
      setError("Cloud sync is not configured.");
      setLoading(false);
      return;
    }
    let cancelled = false;
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    void fetchResolvedSignals(sb, { limit: 1000, signal: ctrl.signal }).then((res) => {
      if (cancelled) return;
      setRows(res.rows);
      setError(res.error);
      setLoading(false);
    });
    return () => {
      cancelled = true;
      ctrl.abort();
    };
  }, [user, nonce]);

  const filtered = useMemo(
    () => applyPerformanceFilters(rows, { category, direction, minScore, range }),
    [rows, category, direction, minScore, range],
  );
  const stats = useMemo(() => computePerformanceStats(filtered), [filtered]);
  const pending = useMemo(() => rows.filter((r) => r.decidedBy.startsWith("PENDING")).length, [rows]);

  const symbolRows = useMemo(() => {
    const q = query.trim().toUpperCase();
    let list = stats.bySymbol;
    if (q) list = list.filter((g) => g.key.toUpperCase().includes(q));
    const sorted = [...list];
    if (symbolSort === "winRate") sorted.sort((a, b) => b.winRate - a.winRate);
    else if (symbolSort === "avgR") sorted.sort((a, b) => b.avgR - a.avgR);
    else if (symbolSort === "signals") sorted.sort((a, b) => b.signals - a.signals);
    else sorted.sort((a, b) => b.cumulativeR - a.cumulativeR);
    return sorted;
  }, [stats, query, symbolSort]);

  const recent = useMemo(
    () =>
      [...filtered]
        .filter((r) => r.verdict === "WIN" || r.verdict === "LOSS" || r.verdict === "BREAKEVEN" || r.verdict === "OPEN")
        .sort((a, b) => (b.outcomeAt ?? b.firstSeen) - (a.outcomeAt ?? a.firstSeen))
        .slice(0, 15),
    [filtered],
  );
  const selected = selectedId !== null ? (filtered.find((r) => r.id === selectedId) ?? rows.find((r) => r.id === selectedId) ?? null) : null;
  const openSignal = (id: string) => setSearchParams({ signal: id });
  const closeSignal = () => setSearchParams({});

  // Paper comparison (aggregates only — trades carry no signal ids, so
  // per-signal linkage is impossible; the limitation is stated, not worked
  // around). Live-subscribed so cloud hydration updates the comparison.
  const [paperSnap, setPaperSnap] = useState(() => getSharedPaperEngine().getSnapshot());
  useEffect(() => getSharedPaperEngine().subscribe(setPaperSnap), []);
  const paper = useMemo(() => {
    const closed = paperSnap.positions.filter((p) => p.closedAt !== null);
    const openCount = paperSnap.positions.filter((p) => p.closedAt === null).length;
    const rs = closed.map((p) => realizedR(p));
    const avg = rs.length > 0 ? rs.reduce((a, b) => a + b, 0) / rs.length : 0;
    return {
      tradesTaken: closed.length,
      openCount,
      pnl: paperSnap.realizedPnl,
      winRate: closed.length > 0 ? (paperSnap.wins / closed.length) * 100 : 0,
      avgR: Math.round(avg * 100) / 100,
    };
  }, [paperSnap]);

  if (!configured || !user) {
    return (
      <div>
        <PageHeader
          title="Signal Performance"
          description="Are the strategy's signals profitable over a meaningful sample? Measured from resolved server signals."
          right={<ConnectionBadge showLabel={false} />}
        />
        <Card>
          <div className="px-5 py-10 text-center">
            <p className="text-sm font-semibold text-slate-200">Sign in to view signal performance.</p>
            <p className="mx-auto mt-1 max-w-md text-xs text-slate-500">
              Performance is computed from server-authoritative signal history, which requires authentication.
              <Link to="/paper" className="font-bold text-cyan-300 hover:underline"> Sign in on the Paper Trading page →</Link>
            </p>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="Signal Performance"
        description="Resolved server signals only — outcomes replay post-signal candles with paper-equivalent thirds exits. Past statistics never imply future results."
        right={
          <div className="flex flex-wrap items-center gap-2">
            <ConnectionBadge showLabel={false} />
            <button
              onClick={() => setNonce((n) => n + 1)}
              disabled={loading}
              className="min-h-[44px] rounded-lg border border-slate-700 px-4 text-xs font-bold text-slate-200 disabled:opacity-40 hover:bg-slate-800"
            >
              {loading ? "Loading…" : "Refresh"}
            </button>
          </div>
        }
      />

      {/* Filters */}
      <Card className="mb-4">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 text-xs">
          <FilterGroup
            label="Category"
            options={["ALL", "CRYPTO", "STOCKS", "COMMODITIES"]}
            value={category === "ALL" ? "ALL" : category.toUpperCase()}
            onPick={(v) => setCategory((v === "ALL" ? "ALL" : v.toLowerCase()) as PerformanceFilters["category"])}
          />
          <FilterGroup label="Direction" options={["ALL", "LONG", "SHORT"]} value={direction} onPick={(v) => setDirection(v as PerformanceFilters["direction"])} />
          <FilterGroup label="Score" options={["ALL", "≥60", "≥70", "≥80", "≥90"]} value={minScore === 0 ? "ALL" : `≥${minScore}`} onPick={(v) => setMinScore(v === "ALL" ? 0 : Number(v.slice(1)))} />
          <FilterGroup label="Date" options={["Today", "7 days", "30 days", "All time"]} value={RANGE_OPTIONS.find((o) => o.value === range)?.label ?? "All time"} onPick={(v) => setRange((RANGE_OPTIONS.find((o) => o.label === v)?.value ?? "all") as DateRange)} />
        </div>
      </Card>

      {loading ? (
        <Card><p className="px-5 py-10 text-center text-sm text-slate-400">Loading resolved signals…</p></Card>
      ) : error ? (
        <Card>
          <div className="px-5 py-10 text-center">
            <p className="text-sm font-semibold text-rose-300">Unable to load signal performance.</p>
            <p className="mx-auto mt-1 max-w-md text-xs text-slate-500">{error}</p>
            <button onClick={() => setNonce((n) => n + 1)} className="mt-3 min-h-[44px] rounded-xl border border-slate-700 px-5 text-xs font-bold text-slate-200 hover:bg-slate-800">
              Retry
            </button>
          </div>
        </Card>
      ) : (
        <>
          {stats.completed < MIN_SAMPLE_WARNING && (
            <p className="mb-4 rounded-xl border border-amber-400/25 bg-amber-400/[0.06] px-4 py-2.5 text-xs text-amber-200">
              ⚠️ Small sample — only {stats.completed} completed signal{stats.completed === 1 ? "" : "s"} in this view.
              Performance may change substantially as more signals are collected.
            </p>
          )}
          {pending > 0 && (
            <p className="mb-4 rounded-xl border border-slate-800 bg-slate-900/60 px-4 py-2.5 text-xs text-slate-400">
              {pending} signal{pending === 1 ? "" : "s"} {pending === 1 ? "is" : "are"} still awaiting resolution
              (open or not yet processed by the resolver job) — excluded from rates below.
            </p>
          )}

          {/* Overview */}
          <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            {[
              ["Total Signals", String(stats.total)],
              ["Activated", String(stats.activated)],
              ["Wins", String(stats.wins)],
              ["Losses", String(stats.losses)],
              ["Breakeven", String(stats.breakeven)],
              ["No Fill", String(stats.noFill)],
              ["Invalidated", String(stats.invalidated)],
              ["Ambiguous", String(stats.ambiguous)],
              ["Open", String(stats.open)],
              ["Expired", String(stats.expired)],
              ["Win Rate", `${stats.winRate.toFixed(1)}%`],
              ["Average R", fmtR(stats.avgR)],
              ["Profit Factor", fmtPF(stats.profitFactor)],
              ["Expectancy", fmtR(stats.expectancy)],
              ["Cumulative R", fmtR(stats.cumulativeR.length > 0 ? stats.cumulativeR[stats.cumulativeR.length - 1].cumulativeR : 0)],
              ["Completed", String(stats.completed)],
            ].map(([k, v]) => (
              <div key={k} className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
                <p className="text-[11px] font-semibold tracking-widest text-slate-500 uppercase">{k}</p>
                <p className="mt-1 font-mono text-lg font-bold text-white">{v}</p>
              </div>
            ))}
          </div>

          {/* Signal Quality Monitor (full history + heartbeats) */}
          <QualityMonitor rows={rows} />

          {/* Cumulative R chart */}
          <Card className="mb-4">
            <CardHeader title="Cumulative R" subtitle="Signal # → running realized R (completed signals, outcome order)" />
            {stats.cumulativeR.length < 2 ? (
              <p className="px-5 py-8 text-center text-sm text-slate-500">Not enough completed signals yet.</p>
            ) : (
              <div className="h-[240px] p-2">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={stats.cumulativeR} margin={{ left: 8, right: 16, top: 8, bottom: 8 }}>
                    <defs>
                      <linearGradient id="cumRFill" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#22d3ee" stopOpacity={0.35} />
                        <stop offset="100%" stopColor="#22d3ee" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="n" stroke="#475569" fontSize={10} tickLine={false} minTickGap={30} />
                    <YAxis stroke="#475569" fontSize={10} tickLine={false} width={56} domain={["auto", "auto"]} />
                    <Tooltip contentStyle={{ background: "#020617", border: "1px solid #1e293b", borderRadius: 12, fontSize: 12 }} labelFormatter={(n) => `Signal #${n}`} />
                    <Area type="monotone" dataKey="cumulativeR" name="Cumulative R" stroke="#22d3ee" fill="url(#cumRFill)" dot={false} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            )}
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <GroupTable title="Category Performance" subtitle="Only categories with data are shown" rows={stats.byCategory} showSampleHint />
            <GroupTable title="LONG vs SHORT" subtitle="Direction comparison" rows={stats.byDirection} showSampleHint />
            <GroupTable title="Score Performance" subtitle="Higher score should earn higher R — analysis only, thresholds unchanged" rows={stats.byScore} showSampleHint />
            <GroupTable title="Timeframe Performance" subtitle="Actual signal timeframes" rows={stats.byTimeframe} showSampleHint />
          </div>

          {/* Symbol table */}
          <Card className="mt-4">
            <CardHeader
              title="Symbol Performance"
              subtitle="Sorted by Total R — sample size always shown, single-signal symbols are not hidden"
              right={
                <div className="flex flex-wrap items-center gap-2">
                  <label className="relative">
                    <span className="sr-only">Search symbol</span>
                    <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-slate-500" />
                    <input
                      value={query}
                      onChange={(e) => setQuery(e.target.value.toUpperCase())}
                      placeholder="Search…"
                      className="h-[44px] rounded-xl border border-slate-800 bg-slate-950 pr-3 pl-9 text-xs text-slate-100 placeholder:text-slate-600 focus:border-cyan-400/60 focus:outline-none"
                    />
                  </label>
                  <select
                    value={symbolSort}
                    onChange={(e) => setSymbolSort(e.target.value as SymbolSort)}
                    aria-label="Sort symbols"
                    className="h-[44px] rounded-xl border border-slate-800 bg-slate-950 px-3 text-xs font-bold text-slate-200 focus:border-cyan-400/60 focus:outline-none"
                  >
                    <option value="totalR">Total R</option>
                    <option value="winRate">Win rate</option>
                    <option value="avgR">Average R</option>
                    <option value="signals">Signals</option>
                  </select>
                </div>
              }
            />
            {symbolRows.length === 0 ? (
              <p className="px-5 py-8 text-center text-sm text-slate-500">No symbols match.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-left text-xs" style={{ minWidth: 720 }}>
                  <thead>
                    <tr className="border-b border-slate-800 text-[10px] tracking-widest text-slate-500 uppercase">
                      {["Symbol", "Category", "Signals", "Wins", "Win Rate", "Avg R", "Total R"].map((c) => (
                        <th key={c} className="px-3 py-2.5 font-semibold whitespace-nowrap">{c}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {symbolRows.map((g) => (
                      <tr key={g.key} className="border-b border-slate-800/50 font-mono last:border-0 hover:bg-slate-900/50">
                        <td className="px-3 py-2 font-bold text-white">{g.key}</td>
                        <td className="px-3 py-2"><CategoryChip symbol={g.key} mainSymbols={mainSymbols} /></td>
                        <td className="px-3 py-2 text-slate-300">{g.signals}</td>
                        <td className="px-3 py-2 text-slate-300">{g.wins}</td>
                        <td className="px-3 py-2 text-slate-200">{g.winRate.toFixed(1)}%</td>
                        <td className="px-3 py-2 text-slate-200">{fmtR(g.avgR)}</td>
                        <td className={cn("px-3 py-2 font-bold", g.cumulativeR > 0 ? "text-emerald-300" : g.cumulativeR < 0 ? "text-rose-300" : "text-slate-300")}>{fmtR(g.cumulativeR)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          {/* Recent results */}
          <Card className="mt-4">
            <CardHeader title="Recent Results" subtitle="Latest completed + open signals in this view — click any row for full details" />
            {recent.length === 0 ? (
              <p className="px-5 py-8 text-center text-sm text-slate-500">No results in this view yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-left text-xs" style={{ minWidth: 820 }}>
                  <thead>
                    <tr className="border-b border-slate-800 text-[10px] tracking-widest text-slate-500 uppercase">
                      {["Time", "Symbol", "Dir", "Score", "Entry", "Outcome", "R", "Path", ""].map((c) => (
                        <th key={c} className="px-3 py-2.5 font-semibold whitespace-nowrap">{c}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {recent.map((r) => (
                      <tr
                        key={r.id}
                        onClick={() => openSignal(r.id)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            openSignal(r.id);
                          }
                        }}
                        tabIndex={0}
                        role="button"
                        aria-label={`Signal details for ${r.symbol} ${r.direction}`}
                        className="cursor-pointer border-b border-slate-800/50 font-mono last:border-0 hover:bg-slate-900/50 focus-visible:outline-2 focus-visible:outline-cyan-400"
                      >
                        <td className="px-3 py-2 whitespace-nowrap text-slate-400">
                          {new Date(r.outcomeAt ?? r.firstSeen).toLocaleString()}
                        </td>
                        <td className="px-3 py-2 font-bold text-white" onClick={(e) => e.stopPropagation()}>
                          <Link to={`/coin/${r.symbol}`} className="hover:text-cyan-300" aria-label={`Open live ${r.symbol} analysis`}>
                            {r.symbol}
                          </Link>
                        </td>
                        <td className={cn("px-3 py-2 font-bold", r.direction === "LONG" ? "text-emerald-300" : "text-rose-300")}>{r.direction}</td>
                        <td className="px-3 py-2 text-slate-200">{r.score}</td>
                        <td className="px-3 py-2 text-slate-400">
                          {r.entryMid !== null ? r.entryMid.toLocaleString("en-US", { maximumFractionDigits: 4 }) : "—"}
                        </td>
                        <td className="px-3 py-2"><VerdictChip verdict={r.verdict} /></td>
                        <td className={cn("px-3 py-2 font-bold", (r.realizedR ?? 0) > 0 ? "text-emerald-300" : (r.realizedR ?? 0) < 0 ? "text-rose-300" : "text-slate-400")}>
                          {r.realizedR !== null ? fmtR(r.realizedR) : "—"}
                        </td>
                        <td className="px-3 py-2 font-sans text-[11px] text-slate-500">{r.decidedBy}</td>
                        <td className="px-3 py-2 text-right font-sans text-xs font-bold whitespace-nowrap text-cyan-300">
                          View <span aria-hidden="true">→</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
          {selected !== null && (
            <SignalDetailsModal
              signal={selected}
              liveMark={marks.get(selected.symbol) ?? null}
              onClose={closeSignal}
            />
          )}

          {/* Paper comparison */}
          <Card className="mt-4">
            <CardHeader title="Signals vs Paper Trades" subtitle="Aggregates side-by-side — per-signal linkage is impossible (trades carry no signal ids)" />
            <div className="grid grid-cols-2 gap-2.5 p-5 sm:grid-cols-3 lg:grid-cols-6">
              {[
                ["Signals generated", String(stats.total)],
                ["Paper trades taken", String(paper.tradesTaken)],
                ["Paper open", String(paper.openCount)],
                ["Paper P&L", `${paper.pnl >= 0 ? "+" : ""}$${paper.pnl.toFixed(2)}`],
                ["Paper win rate", `${paper.winRate.toFixed(1)}%`],
                ["Paper avg R", `${paper.avgR >= 0 ? "+" : ""}${paper.avgR.toFixed(2)}R`],
              ].map(([k, v]) => (
                <div key={k} className="rounded-xl border border-slate-800 bg-slate-950/60 p-3">
                  <p className="text-[11px] font-bold tracking-widest text-slate-500 uppercase">{k}</p>
                  <p className="mt-1 font-mono text-[15px] font-bold text-slate-100">{v}</p>
                </div>
              ))}
            </div>
            <p className="border-t border-slate-800/70 px-5 py-3 text-[11px] leading-relaxed text-slate-600">
              Limitation: paper trades are opened manually or by auto-paper from live marks, not from journaled
              signal ids — "signals not traded" cannot be computed exactly. Paper trades are never modified to
              match signals; both series are reported as-is.
            </p>
          </Card>

          {/* Methodology */}
          <Card className="mt-4">
            <CardHeader title="Methodology" subtitle="How every number above is produced" />
            <div className="space-y-2 px-5 py-4 text-xs leading-relaxed text-slate-400">
              <p><span className="font-bold text-slate-200">Activation.</span> RETEST signals begin TP/SL monitoring only once a bar intersects the entry zone (activation at the entry-mid estimate — always labeled estimated, since OHLC cannot prove a fill). MARKET signals activate at the signal bar. A stop print before any zone touch is INVALIDATED (never a loss — no fill happened); a lifetime without a touch is NO_FILL. Rows written before entry tracking measure exactly as before (documented legacy rule, no retroactive change).</p>
              <p><span className="font-bold text-slate-200">Outcome.</span> Post-activation candles replay equal-thirds exits at TP1/TP2/TP3; on any bar the stop is processed before targets (same conservative rule as paper trading). Full stop → −1R; full TP1/TP2/TP3 cascade → +2R. |R| ≤ 0.1 → BREAKEVEN. A bar touching both stop and target is resolved with finer-timeframe candles when available, otherwise kept as a conservative loss flagged ambiguous (counted separately, never hidden). Activated-but-open past 24h → EXPIRED. Data ends first → OPEN. Unmeasurable plan or no data → UNKNOWN (never guessed).</p>
              <p><span className="font-bold text-slate-200">Win Rate.</span> Wins / completed activated trades (WIN+LOSS+BREAKEVEN). NO_FILL, INVALIDATED, OPEN, EXPIRED and UNKNOWN are excluded from rates, always counted separately.</p>
              <p><span className="font-bold text-slate-200">Average R.</span> Mean realized R across completed signals. <span className="font-bold text-slate-200">Expectancy.</span> Average R per completed signal (identical by definition).</p>
              <p><span className="font-bold text-slate-200">Profit Factor.</span> Gross positive R / absolute gross negative R (∞ with no losers, 0 with no winners).</p>
              <p><span className="font-bold text-slate-200">Cumulative R.</span> Running sum of realized R in outcome order.</p>
              <p><span className="font-bold text-slate-200">Bias controls.</span> Outcomes use only candles printed after the signal timestamp (no look-ahead); original entries are never rewritten (no repainting); every generated signal is resolved including losers and expired (no survivorship filtering); server history is capped by the 30-day retention window.</p>
              <p className="rounded-xl border border-amber-400/25 bg-amber-400/[0.06] px-3 py-2 text-amber-200">
                Historical paper/signal statistics only — they do not guarantee future results. This page measures; it never changes the strategy.
              </p>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
