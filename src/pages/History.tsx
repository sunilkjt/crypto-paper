import { memo, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Search } from "lucide-react";
import { Card, CardHeader, PageHeader } from "../components/ui";
import { ConnectionBadge } from "../components/ConnectionBadge";
import {
  clearJournal,
  loadJournal,
  upsertJournalSignal,
  type JournalEntry,
  type JournalStatus,
} from "../signals/journal";
import { trackOutcome } from "../signals/outcomes";
import { getCachedCandles } from "../market/hyperliquid";
import { getCandleWindow } from "../market/hyperliquid/timeframes";
import type { Timeframe } from "../market/hyperliquid/types";
import { cn } from "../lib/cn";

type StatusFilter = "ALL" | "ACTIVE" | "NEW" | "STRENGTHENING" | "WEAKENING" | "INVALIDATED" | "COMPLETED" | "EXPIRED";
type DirectionFilter = "ALL" | "LONG" | "SHORT";
type RecencyFilter = "ALL" | "24H" | "7D" | "30D";
type SortKey = "newest" | "oldest" | "score";

const ACTIVE_STATUSES = ["NEW", "ACTIVE", "STRENGTHENING", "WEAKENING"];
const PAGE_SIZE = 25;

const RECENCY_MS: Record<Exclude<RecencyFilter, "ALL">, number> = {
  "24H": 86_400_000,
  "7D": 604_800_000,
  "30D": 2_592_000_000,
};

const DIR_CHIP = {
  LONG: "border-emerald-400/30 bg-emerald-400/10 text-emerald-300",
  SHORT: "border-rose-400/30 bg-rose-400/10 text-rose-300",
} as const;

const STATUS_META: Record<JournalStatus, { icon: string; chip: string }> = {
  COMPLETED: { icon: "✓", chip: "border-emerald-400/30 bg-emerald-400/10 text-emerald-300" },
  INVALIDATED: { icon: "✕", chip: "border-rose-400/30 bg-rose-400/10 text-rose-300" },
  EXPIRED: { icon: "—", chip: "border-slate-700 bg-slate-800 text-slate-500" },
  NEW: { icon: "●", chip: "border-cyan-400/30 bg-cyan-400/10 text-cyan-300" },
  ACTIVE: { icon: "●", chip: "border-cyan-400/30 bg-cyan-400/10 text-cyan-300" },
  STRENGTHENING: { icon: "●", chip: "border-cyan-400/30 bg-cyan-400/10 text-cyan-300" },
  WEAKENING: { icon: "●", chip: "border-cyan-400/30 bg-cyan-400/10 text-cyan-300" },
};

function fmtDateTime(ms: number): string {
  const d = new Date(ms);
  return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} · ${d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const m = Math.round(ms / 60_000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function fmtNum(v: number | null): string {
  return v === null || !Number.isFinite(v) ? "—" : String(v);
}

/**
 * Signal journal: every recorded setup with lifecycle status and observed
 * outcomes (TP touches, invalidation, MFE/MAE — touches, never profit
 * claims). Outcomes refresh for open signals on visit, bounded to 15.
 */
export default function History() {
  const [entries, setEntries] = useState<JournalEntry[]>(() => loadJournal());
  const [filter, setFilter] = useState<StatusFilter>("ALL");
  const [query, setQuery] = useState("");
  const [dirFilter, setDirFilter] = useState<DirectionFilter>("ALL");
  const [tfFilter, setTfFilter] = useState("ALL");
  const [recency, setRecency] = useState<RecencyFilter>("ALL");
  const [sortKey, setSortKey] = useState<SortKey>("newest");
  const [page, setPage] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [initialized, setInitialized] = useState(false);
  const [loadError, setLoadError] = useState(false);

  const refreshOutcomes = async () => {
    const open = loadJournal()
      .filter((e) => ACTIVE_STATUSES.includes(e.status))
      .sort((a, b) => b.lastSeen - a.lastSeen)
      .slice(0, 15);
    if (open.length === 0) return;
    setRefreshing(true);
    try {
      await Promise.all(
        open.map(async (e) => {
          try {
            const tf = (["5m", "15m", "1h", "4h"].includes(e.timeframe) ? e.timeframe : "15m") as Timeframe;
            const w = getCandleWindow(tf, Date.now(), 300);
            const res = await getCachedCandles(e.symbol, tf, w.startTime, w.endTime);
            const follow = res.candles.filter((c) => c.timestamp > e.dataTimestamp);
            if (follow.length === 0 || e.entryLow === null || e.entryHigh === null) return;
            const entryMid = (e.entryLow + e.entryHigh) / 2;
            const risk = e.direction === "LONG" ? entryMid - (e.invalidation ?? entryMid) : (e.invalidation ?? entryMid) - entryMid;
            if (!(risk > 0) || e.invalidation === null || e.tp1 === null || e.tp2 === null || e.tp3 === null) return;
            const outcome = trackOutcome({
              direction: e.direction,
              entryMid,
              risk,
              invalidation: e.invalidation,
              tp1: e.tp1,
              tp2: e.tp2,
              tp3: e.tp3,
              followCandles: follow,
            });
            // Terminal touches advance the lifecycle honestly.
            let status = e.status;
            if (outcome.invalidationReached && (e.status === "NEW" || e.status === "ACTIVE" || e.status === "WEAKENING" || e.status === "STRENGTHENING")) {
              status = "INVALIDATED";
            } else if (outcome.tp3Reached && status !== "COMPLETED") {
              status = "COMPLETED";
            }
            upsertJournalSignal({ ...e, status, outcome, newsHeadlines: e.newsHeadlines, now: Date.now() });
          } catch {
            // per-entry isolation: one bad refresh never blocks the rest
          }
        }),
      );
    } finally {
      setEntries(loadJournal());
      setRefreshing(false);
    }
  };

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        await refreshOutcomes();
      } catch {
        if (alive) setLoadError(true);
      } finally {
        if (alive) setInitialized(true);
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const retryLoad = () => {
    setLoadError(false);
    void (async () => {
      try {
        await refreshOutcomes();
      } catch {
        setLoadError(true);
      }
    })();
  };

  const timeframes = useMemo(() => {
    const set = new Set<string>();
    for (const e of entries) if (e.timeframe) set.add(e.timeframe);
    return ["ALL", ...[...set].sort()];
  }, [entries]);

  const filtered = useMemo(() => {
    const q = query.trim().toUpperCase();
    let list = entries;
    if (filter === "ACTIVE") list = list.filter((e) => ACTIVE_STATUSES.includes(e.status));
    else if (filter !== "ALL") list = list.filter((e) => e.status === filter);
    if (q) list = list.filter((e) => e.symbol.includes(q));
    if (dirFilter !== "ALL") list = list.filter((e) => e.direction === dirFilter);
    if (tfFilter !== "ALL") list = list.filter((e) => e.timeframe === tfFilter);
    if (recency !== "ALL") {
      const cutoff = Date.now() - RECENCY_MS[recency];
      list = list.filter((e) => e.lastSeen >= cutoff);
    }
    const sorted = [...list];
    if (sortKey === "oldest") sorted.sort((a, b) => a.lastSeen - b.lastSeen);
    else if (sortKey === "score") sorted.sort((a, b) => b.strength - a.strength || b.lastSeen - a.lastSeen);
    else sorted.sort((a, b) => b.lastSeen - a.lastSeen);
    return sorted;
  }, [entries, filter, query, dirFilter, tfFilter, recency, sortKey]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const rows = filtered.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);
  const rangeStart = filtered.length === 0 ? 0 : safePage * PAGE_SIZE + 1;
  const rangeEnd = Math.min(filtered.length, safePage * PAGE_SIZE + PAGE_SIZE);

  const setFilterAndPage = <T,>(setter: (v: T) => void, v: T) => {
    setter(v);
    setPage(0);
  };

  const filtersActive =
    query.trim() !== "" || dirFilter !== "ALL" || filter !== "ALL" || tfFilter !== "ALL" || recency !== "ALL";

  const clearFilters = () => {
    setQuery("");
    setDirFilter("ALL");
    setFilter("ALL");
    setTfFilter("ALL");
    setRecency("ALL");
    setPage(0);
  };

  const tp1Hits = entries.filter((e) => e.outcome?.tp1Reached).length;
  const invHits = entries.filter((e) => e.status === "INVALIDATED").length;

  return (
    <div>
      <PageHeader
        title="Signal History"
        description="Journaled setups with lifecycle status and observed level touches. Touches are facts, not profit claims."
        right={
          <div className="flex flex-wrap items-center gap-2">
            <ConnectionBadge showLabel={false} />
            <button
              onClick={() => {
                clearJournal();
                setEntries([]);
              }}
              className="min-h-[44px] rounded-lg border border-slate-700 px-4 text-xs font-bold text-slate-300 hover:bg-slate-800"
            >
              Clear journal
            </button>
          </div>
        }
      />

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          ["Total Signals", String(entries.length), "journaled setups"],
          ["Active", String(entries.filter((e) => ACTIVE_STATUSES.includes(e.status)).length), "open lifecycle states"],
          ["TP1 Touched", String(tp1Hits), "observed level touches"],
          ["Invalidated", String(invHits), "stopped setups"],
        ].map(([k, v, s]) => (
          <div key={k} className="min-w-0 rounded-xl border border-slate-800 bg-slate-900/60 p-4">
            <p className="text-[11px] font-semibold tracking-widest break-words text-slate-500 uppercase">{k}</p>
            <p className="mt-1 font-mono text-lg font-bold break-words text-white">{v}</p>
            <p className="break-words text-xs text-slate-500">{s}</p>
          </div>
        ))}
      </div>

      <Card>
        <CardHeader
          title="All Signals"
          subtitle={`${filtered.length} shown · lifecycle status + observed touches`}
          right={
            <button
              onClick={() => void refreshOutcomes()}
              disabled={refreshing}
              className="min-h-[44px] rounded-lg border border-slate-700 px-4 text-xs font-bold text-slate-200 disabled:opacity-40 hover:bg-slate-800"
            >
              {refreshing ? "Checking levels…" : "Refresh outcomes"}
            </button>
          }
        />

        {/* Filters */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-slate-800/70 px-4 py-3 text-xs">
          <FilterGroup label="Status" options={["ALL", "ACTIVE", "NEW", "STRENGTHENING", "WEAKENING", "INVALIDATED", "COMPLETED", "EXPIRED"]} value={filter} onPick={(v) => setFilterAndPage(setFilter, v as StatusFilter)} />
          <FilterGroup label="Direction" options={["ALL", "LONG", "SHORT"]} value={dirFilter} onPick={(v) => setFilterAndPage(setDirFilter, v as DirectionFilter)} />
          <FilterGroup label="Timeframe" options={timeframes} value={tfFilter} onPick={(v) => setFilterAndPage(setTfFilter, v)} />
          <FilterGroup label="Date" options={["ALL", "24H", "7D", "30D"]} value={recency} onPick={(v) => setFilterAndPage(setRecency, v as RecencyFilter)} />
          <label className="relative min-h-[44px] w-full flex-1 sm:min-w-[180px] sm:max-w-[240px]">
            <span className="sr-only">Search coin</span>
            <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-slate-500" />
            <input
              value={query}
              onChange={(e) => setFilterAndPage(setQuery, e.target.value)}
              placeholder="Search coin…"
              className="h-[44px] w-full rounded-xl border border-slate-800 bg-slate-950 pr-3 pl-9 text-xs text-slate-100 placeholder:text-slate-600 focus:border-cyan-400/60 focus:outline-none"
            />
          </label>
          <span className="inline-flex items-center gap-2">
            <label htmlFor="history-sort" className="font-bold tracking-widest text-slate-500 uppercase">Sort</label>
            <select
              id="history-sort"
              value={sortKey}
              onChange={(e) => setFilterAndPage(setSortKey, e.target.value as SortKey)}
              className="h-[44px] rounded-xl border border-slate-800 bg-slate-950 px-3 text-xs font-bold text-slate-200 focus:border-cyan-400/60 focus:outline-none"
            >
              <option value="newest">Newest</option>
              <option value="oldest">Oldest</option>
              <option value="score">Highest Score</option>
            </select>
          </span>
        </div>

        <div className="px-4 py-4">
          {loadError ? (
            <div className="py-8 text-center">
              <p className="text-sm font-semibold text-rose-300">Unable to load signal history.</p>
              <p className="mx-auto mt-1 max-w-md text-xs text-slate-500">Please try again. Your saved records are untouched.</p>
              <button onClick={retryLoad} className="mt-3 min-h-[44px] rounded-xl border border-slate-700 px-5 text-xs font-bold text-slate-200 hover:bg-slate-800">
                Retry
              </button>
            </div>
          ) : !initialized ? (
            <SkeletonGrid />
          ) : rows.length === 0 ? (
            filtersActive ? (
              <div className="py-8 text-center">
                <p className="text-sm font-semibold text-slate-200">No signals match your filters.</p>
                <button onClick={clearFilters} className="mt-3 min-h-[44px] rounded-xl border border-slate-700 px-5 text-xs font-bold text-slate-200 hover:bg-slate-800">
                  Clear Filters
                </button>
              </div>
            ) : (
              <div className="py-8 text-center">
                <p className="text-sm font-semibold text-slate-200">No signal history yet.</p>
                <p className="mx-auto mt-1 max-w-md text-xs text-slate-500">
                  Signals will appear here after the scanner generates them.
                </p>
              </div>
            )
          ) : (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              {rows.map((e) => (
                <HistoryCard key={e.id} e={e} />
              ))}
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-800/80 px-4 py-3 text-xs text-slate-500">
          <span aria-live="polite" className="min-w-0 break-words">
            Showing {rangeStart}–{rangeEnd} of {filtered.length}
          </span>
          <div className="flex items-center gap-2">
            <button disabled={safePage === 0} onClick={() => setPage((p) => Math.max(0, p - 1))} aria-label="Previous page" className="min-h-[44px] rounded-lg border border-slate-800 px-4 font-bold text-slate-300 disabled:opacity-40 hover:bg-slate-900">← <span className="hidden sm:inline">Previous</span></button>
            <span aria-live="polite">{safePage + 1} / {pageCount}</span>
            <button disabled={safePage >= pageCount - 1} onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))} aria-label="Next page" className="min-h-[44px] rounded-lg border border-slate-800 px-4 font-bold text-slate-300 disabled:opacity-40 hover:bg-slate-900"><span className="hidden sm:inline">Next</span> →</button>
          </div>
        </div>
      </Card>
    </div>
  );
}

const HistoryCard = memo(function HistoryCard({ e }: { e: JournalEntry }) {
  const meta = STATUS_META[e.status];
  const coinHref = `/coin/${e.symbol}`;
  const entry =
    e.entryLow !== null && e.entryHigh !== null
      ? `${fmtNum(e.entryLow)}–${fmtNum(e.entryHigh)}`
      : e.entryLow !== null
        ? fmtNum(e.entryLow)
        : "—";
  const o = e.outcome;

  return (
    <article
      aria-label={`${e.symbol} ${e.direction} signal, ${e.status}, strength ${e.strength}`}
      className="flex min-w-0 flex-col rounded-2xl border border-slate-800 bg-slate-900/70 break-words"
    >
      {/* Header: coin + direction + result. Navigates to the coin (always known). */}
      <Link
        to={coinHref}
        className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-slate-800/80 px-4 py-3 focus-visible:outline-2 focus-visible:outline-cyan-400"
        aria-label={`${e.symbol}, ${e.direction}, ${e.status}. Open analysis.`}
      >
        <span className="text-base font-extrabold tracking-tight text-white">{e.symbol}</span>
        <span className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[10px] font-bold text-slate-400">{e.setupType}</span>
        <span className={cn("inline-flex min-h-[28px] items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-bold", DIR_CHIP[e.direction])}>
          {e.direction} <span aria-hidden="true">{e.direction === "LONG" ? "🟢" : "🔴"}</span>
        </span>
        <span className={cn("ml-auto inline-flex min-h-[28px] items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold tracking-wider", meta.chip)}>
          <span aria-hidden="true">{meta.icon}</span> {e.status}
        </span>
      </Link>

      {/* Body navigates to the coin analysis page. */}
      <Link
        to={coinHref}
        className="flex min-w-0 flex-1 flex-col gap-3 p-4 focus-visible:outline-2 focus-visible:outline-cyan-400"
        aria-label={`${e.symbol} details. Open analysis.`}
        tabIndex={-1}
      >
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <p className="min-w-0 text-xs text-slate-400">{fmtDateTime(e.firstSeen)}</p>
          <p className="font-mono text-sm font-bold text-slate-100">
            Score {e.strength}{" "}
            <span className="rounded-md border border-slate-700 bg-slate-800 px-1.5 py-0.5 font-sans text-[10px] font-bold tracking-wider text-slate-300">
              {e.quality}
            </span>
          </p>
        </div>

        {/* Trade levels */}
        <dl className="grid grid-cols-2 gap-2">
          <Level label="Entry" value={entry} />
          <Level label="Stop loss" value={fmtNum(e.invalidation)} />
          <Level label="TP1" value={fmtNum(e.tp1)} />
          <Level label="TP2" value={fmtNum(e.tp2)} />
          <Level label="TP3" value={fmtNum(e.tp3)} />
          <Level label="R:R" value={e.riskReward !== null ? `1 : ${e.riskReward}` : "—"} />
        </dl>

        {/* Observed touches */}
        <div>
          <p className="mb-1 text-[10px] font-bold tracking-widest text-slate-500 uppercase">Observed touches</p>
          {o ? (
            <p className="font-mono text-xs font-bold" aria-label={`TP1 ${o.tp1Reached ? "reached" : "not reached"}, TP2 ${o.tp2Reached ? "reached" : "not reached"}, TP3 ${o.tp3Reached ? "reached" : "not reached"}, invalidation ${o.invalidationReached ? "reached" : "not reached"}`}>
              <Touch on={o.tp1Reached} label="T1" good />
              {" "}<Touch on={o.tp2Reached} label="T2" good />
              {" "}<Touch on={o.tp3Reached} label="T3" good />
              {" "}<Touch on={o.invalidationReached} label="X" good={false} />
              <span className="ml-2 font-sans font-normal text-slate-500">MFE {o.mfeR}R · MAE {o.maeR}R</span>
            </p>
          ) : (
            <p className="font-mono text-xs text-slate-500">No follow-up candles yet</p>
          )}
        </div>

        {/* Recorded details */}
        <details className="rounded-xl border border-slate-800 bg-slate-950/60">
          <summary className="flex min-h-[44px] cursor-pointer items-center px-3 text-xs font-bold text-slate-300 focus-visible:outline-2 focus-visible:outline-cyan-400">
            Details
          </summary>
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 border-t border-slate-800/70 px-3 py-3 text-xs">
            <TechRow label="Timeframe" value={e.timeframe} mono />
            <TechRow label="Tracked" value={formatDuration(e.lastSeen - e.firstSeen)} mono />
            <TechRow label="MFE" value={o ? `${o.mfeR}R` : "—"} mono />
            <TechRow label="MAE" value={o ? `${o.maeR}R` : "—"} mono />
            <TechRow label="Bars observed" value={o ? String(o.barsObserved) : "—"} mono />
            <TechRow label="Time to TP1" value={o?.timeToTp1Ms != null ? formatDuration(o.timeToTp1Ms) : "—"} mono />
            <TechRow label="Time to stop" value={o?.timeToInvalidationMs != null ? formatDuration(o.timeToInvalidationMs) : "—"} mono />
            <TechRow label="Last seen" value={fmtDateTime(e.lastSeen)} />
          </dl>
          <p className="border-t border-slate-800/70 px-3 py-2 font-mono text-[10px] break-all text-slate-600" title={e.id}>
            {e.id}
          </p>
          {(e.aiSummary || e.newsHeadlines.length > 0) && (
            <div className="space-y-1.5 border-t border-slate-800/70 px-3 py-3 text-xs leading-relaxed">
              {e.aiSummary && (
                <div className="min-w-0">
                  <p className="mb-0.5 text-[10px] font-bold tracking-widest text-violet-300/90 uppercase">
                    <span aria-hidden="true">✨</span> AI explanation
                  </p>
                  <p className="break-words text-slate-300">{e.aiSummary}</p>
                </div>
              )}
              {e.newsHeadlines.map((h, i) => (
                <p key={i} className="break-words text-slate-500">· {h}</p>
              ))}
            </div>
          )}
        </details>

        <p className="mt-auto flex min-h-[44px] items-center justify-between gap-2 border-t border-slate-800/70 pt-3 text-xs">
          <span className="rounded bg-slate-800 px-2 py-1 font-mono text-[10px] font-bold text-slate-400">{e.timeframe} setup</span>
          <span className="font-bold text-cyan-300">View Analysis <span aria-hidden="true">→</span></span>
        </p>
      </Link>
    </article>
  );
});

function Touch({ on, label, good }: { on: boolean; label: string; good: boolean }) {
  return (
    <span className={cn(on && (good ? "text-emerald-300" : "text-rose-300"), !on && "text-slate-600")}>
      {label}{on ? "✓" : "·"}
    </span>
  );
}

function Level({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-xl border border-slate-800 bg-slate-950/60 px-3 py-2">
      <dt className="text-[10px] font-bold tracking-widest text-slate-500 uppercase">{label}</dt>
      <dd className="mt-0.5 font-mono text-[13px] font-bold break-words text-slate-100">{value}</dd>
    </div>
  );
}

function TechRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-2">
      <dt className="shrink-0 text-slate-500">{label}</dt>
      <dd className={cn("min-w-0 text-right break-words text-slate-200", mono && "font-mono")}>{value}</dd>
    </div>
  );
}

function SkeletonGrid() {
  return (
    <div role="status" aria-label="Loading signal history">
      <div aria-hidden="true" className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="animate-pulse rounded-2xl border border-slate-800 bg-slate-900/70 p-4">
            <div className="flex items-center justify-between">
              <div className="h-5 w-1/4 rounded bg-slate-800" />
              <div className="h-5 w-1/4 rounded bg-slate-800" />
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <div className="h-12 rounded-xl bg-slate-800/70" />
              <div className="h-12 rounded-xl bg-slate-800/70" />
              <div className="h-12 rounded-xl bg-slate-800/70" />
              <div className="h-12 rounded-xl bg-slate-800/70" />
            </div>
            <div className="mt-3 h-4 w-2/3 rounded bg-slate-800" />
          </div>
        ))}
      </div>
      <span className="sr-only">Loading signal history…</span>
    </div>
  );
}

function FilterGroup({ label, options, value, onPick }: { label: string; options: string[]; value: string; onPick: (v: string) => void }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5" role="group" aria-label={`${label} filter`}>
      <span className="font-bold tracking-widest text-slate-500 uppercase">{label}</span>
      {options.map((o) => (
        <button
          key={o}
          onClick={() => onPick(o)}
          aria-pressed={value === o}
          className={cn("min-h-[44px] rounded-lg border px-3 font-bold", value === o ? "border-cyan-400/50 bg-cyan-400/10 text-cyan-200" : "border-slate-800 text-slate-500 hover:border-slate-700")}
        >
          {o === "24H" ? "24h" : o === "7D" ? "7d" : o === "30D" ? "30d" : o}
        </button>
      ))}
    </span>
  );
}
