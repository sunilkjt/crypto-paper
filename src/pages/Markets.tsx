import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import { Card, CardHeader, PageHeader } from "../components/ui";
import { FilterGroup, SignalCard } from "../components/SignalCard";
import { FreshnessLabel } from "../components/LiveBadge";
import { ConnectionBadge } from "../components/ConnectionBadge";
import { timeAgo } from "../components/NewsList";
import { useMarkets } from "../market/store";
import { classifyMarket, type MarketClass } from "../market/classify";
import { DEFAULT_ELIGIBILITY, runFullScan, type ScanSummary } from "../scanner";
import { addWatched, isWatched, loadWatchlist, removeWatched } from "../alerts/watchlist";
import { cn } from "../lib/cn";

type Category = "stocks" | "commodities";
type DirectionFilter = "ALL" | "LONG" | "SHORT" | "WAIT";
type SortKey = "strength" | "newest" | "riskReward";

const CATEGORY_KEY = "cryptoin:markets-category:v1";
const PAGE_SIZE = 25;
const UNIVERSE_CAP = 60;
const AUTO_RESCAN_MS = 60_000;

function loadCategory(): Category | null {
  try {
    const v = typeof localStorage !== "undefined" ? localStorage.getItem(CATEGORY_KEY) : null;
    return v === "stocks" || v === "commodities" ? v : null;
  } catch {
    return null;
  }
}

/**
 * Tokenized-equity & commodity scanner on HIP-3 builder dexes. Gated by
 * explicit category selection: NOTHING is fetched or scored until the user
 * picks Stocks or Commodities (return visits restore the selection but still
 * require Start Scan). Leaving the page aborts the scanner via cleanup.
 * Pure runFullScan: no journal, no alerts, no crypto-scanner side effects.
 */
export default function Markets() {
  const { markets, error: marketError, updatedAt, stale } = useMarkets();
  const [category, setCategory] = useState<Category | null>(() => loadCategory());
  const [started, setStarted] = useState(false);
  const [summary, setSummary] = useState<ScanSummary | null>(null);
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [paused, setPaused] = useState(false);
  const [runId, setRunId] = useState(0);
  const [scanError, setScanError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [dirFilter, setDirFilter] = useState<DirectionFilter>("ALL");
  const [sortKey, setSortKey] = useState<SortKey>("strength");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [page, setPage] = useState(0);
  const [watchlist, setWatchlist] = useState<string[]>(() => loadWatchlist());
  const abortRef = useRef<AbortController | null>(null);
  const marketsRef = useRef(markets);
  marketsRef.current = markets;

  const toggleStar = useCallback((symbol: string) => {
    setWatchlist((list) => (isWatched(symbol, list) ? removeWatched(symbol) : addWatched(symbol)));
  }, []);

  // Live class counts from the already-loaded global list (no extra requests).
  const counts = useMemo(() => {
    const main = new Set(markets.filter((m) => !m.symbol.includes(":")).map((m) => m.symbol.toUpperCase()));
    let stocks = 0;
    let commodities = 0;
    for (const m of markets) {
      const c = classifyMarket(m.symbol, main);
      if (c === "stocks") stocks += 1;
      else if (c === "commodities") commodities += 1;
    }
    return { stocks, commodities };
  }, [markets]);

  const prices = useMemo(() => new Map(markets.map((m) => [m.symbol, m])), [markets]);

  const runScan = useCallback(async () => {
    const snapshot = marketsRef.current;
    const main = new Set(snapshot.filter((m) => !m.symbol.includes(":")).map((m) => m.symbol.toUpperCase()));
    const all = snapshot.filter((m) => classifyMarket(m.symbol, main) === (category as MarketClass));
    if (category === null || all.length === 0 || stale) return;
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setScanning(true);
    setProgress({ done: 0, total: 0 });
    setScanError(null);
    try {
      const result = await runFullScan(all, {
        eligibility: { ...DEFAULT_ELIGIBILITY, universeSize: UNIVERSE_CAP },
        setupTimeframe: "15m",
        concurrency: 4,
        onProgress: (done, total) => setProgress({ done, total }),
        signal: ctrl.signal,
      });
      if (ctrl.signal.aborted) return;
      setSummary(result);
    } catch (err) {
      if (ctrl.signal.aborted) return;
      setScanError(err instanceof Error && err.message ? err.message : "Market data connection is temporarily unavailable.");
    } finally {
      if (!ctrl.signal.aborted) setScanning(false);
    }
  }, [category, stale]);

  // Trigger: explicit selection, Start Scan, Refresh — never market ticks.
  useEffect(() => {
    if (!started || !category) return;
    void runScan();
    return () => {
      abortRef.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [started, category, runId, runScan]);

  // Sensible auto-rescan while started; paused/stale/off-page stops it.
  useEffect(() => {
    if (!started || !category || paused || stale) return;
    const id = window.setInterval(() => void runScan(), AUTO_RESCAN_MS);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [started, category, paused, stale, runId, runScan]);

  // Unmount: stop all expensive work.
  useEffect(() => () => abortRef.current?.abort(), []);

  const selectCategory = (c: Category) => {
    try {
      localStorage?.setItem(CATEGORY_KEY, c);
    } catch {
      // best effort
    }
    setSummary(null);
    setScanError(null);
    setPage(0);
    setQuery("");
    setDirFilter("ALL");
    setCategory(c);
    setPaused(false);
    setStarted(true);
  };

  const filtered = useMemo(() => {
    const q = query.trim().toUpperCase();
    let rows = summary?.results ?? [];
    if (q) rows = rows.filter((r) => r.symbol.includes(q));
    if (dirFilter !== "ALL") rows = rows.filter((r) => r.signal.direction === dirFilter);
    const dir = sortDir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      if (sortKey === "newest") return (a.signal.timestamp - b.signal.timestamp) * dir;
      if (sortKey === "riskReward") {
        const av = a.signal.riskReward;
        const bv = b.signal.riskReward;
        if (av === null && bv === null) return 0;
        if (av === null) return 1;
        if (bv === null) return -1;
        return (av - bv) * dir;
      }
      return (a.signal.signalStrength - b.signal.signalStrength) * dir;
    });
  }, [summary, query, dirFilter, sortKey, sortDir]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const rows = filtered.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);
  const found = (summary?.results ?? []).filter((r) => r.signal.direction !== "WAIT").length;

  const setFilterAndPage = <T,>(setter: (v: T) => void, v: T) => {
    setter(v);
    setPage(0);
  };

  return (
    <div>
      <PageHeader
        title="Markets"
        description="Scan selected Hyperliquid stock and commodity markets. Nothing scans until you pick a category."
        right={
          <div className="flex flex-wrap items-center gap-2">
            <FreshnessLabel updatedAt={updatedAt} />
            <ConnectionBadge />
          </div>
        }
      />

      {/* Category selection */}
      <Card>
        <CardHeader
          title="Market Category"
          subtitle={category === null ? "Select a category to begin scanning" : `${category === "stocks" ? "Stocks" : "Commodities"} selected`}
        />
        <div className="grid grid-cols-2 gap-3 p-4">
          {(["stocks", "commodities"] as const).map((c) => (
            <button
              key={c}
              onClick={() => selectCategory(c)}
              aria-pressed={category === c}
              className={cn(
                "min-h-[56px] rounded-2xl border px-4 py-3 text-left",
                category === c
                  ? "border-cyan-400/50 bg-cyan-400/10"
                  : "border-slate-800 bg-slate-950/60 hover:border-slate-700",
              )}
            >
              <span className="block text-sm font-extrabold tracking-tight text-white">
                {c === "stocks" ? "Stocks" : "Commodities"}
              </span>
              <span className="mt-0.5 block font-mono text-[11px] text-slate-500">
                {c === "stocks" ? `${counts.stocks} listed` : `${counts.commodities} listed`}
              </span>
            </button>
          ))}
        </div>
      </Card>

      {category === null ? (
        <Card className="mt-4">
          <p className="px-5 py-10 text-center text-sm text-slate-400">
            Select a market category to begin scanning.
            <span className="mx-auto mt-1 block max-w-md text-xs text-slate-600">
              No market-data requests beyond the shared snapshot happen until then.
            </span>
          </p>
        </Card>
      ) : (
        <Card className="mt-4">
          <CardHeader
            title={category === "stocks" ? "Stocks" : "Commodities"}
            subtitle={
              summary
                ? `Markets scanned: ${summary.scanned} · Signals found: ${found} · TF 15m`
                : started
                  ? "Starting scan…"
                  : "Category restored — press Start Scan when ready"
            }
            right={
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[11px] text-slate-500">
                  {scanning ? `SCANNING ${progress.done}/${progress.total}` : summary ? `COMPLETE · ${timeAgo(summary.completedAt)}` : stale ? "PAUSED · DATA STALE" : ""}
                </span>
                <button
                  onClick={() => setPaused((p) => !p)}
                  aria-pressed={paused}
                  className="min-h-[44px] rounded-lg border border-slate-700 px-4 text-xs font-bold text-slate-200 hover:bg-slate-800"
                >
                  {paused ? "Resume" : "Pause"}
                </button>
                <button
                  onClick={() => {
                    setStarted(true);
                    setRunId((n) => n + 1);
                  }}
                  className="min-h-[44px] rounded-lg border border-slate-700 px-4 text-xs font-bold text-slate-200 hover:bg-slate-800"
                >
                  {started ? "Refresh" : "Start Scan"}
                </button>
              </div>
            }
          />

          {/* Filters */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-slate-800/70 px-4 py-3 text-xs">
            <FilterGroup label="Direction" options={["ALL", "LONG", "SHORT", "WAIT"]} value={dirFilter} onPick={(v) => setFilterAndPage(setDirFilter, v as DirectionFilter)} />
            <label className="relative min-h-[44px] w-full flex-1 sm:min-w-[180px] sm:max-w-[240px]">
              <span className="sr-only">Search markets</span>
              <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-slate-500" />
              <input
                value={query}
                onChange={(e) => setFilterAndPage(setQuery, e.target.value)}
                placeholder="Search markets…"
                className="h-[44px] w-full rounded-xl border border-slate-800 bg-slate-950 pr-3 pl-9 text-xs text-slate-100 placeholder:text-slate-600 focus:border-cyan-400/60 focus:outline-none"
              />
            </label>
            <span className="inline-flex items-center gap-2">
              <label htmlFor="markets-sort" className="font-bold tracking-widest text-slate-500 uppercase">Sort</label>
              <select
                id="markets-sort"
                value={sortKey}
                onChange={(e) => setFilterAndPage(setSortKey, e.target.value as SortKey)}
                className="h-[44px] rounded-xl border border-slate-800 bg-slate-950 px-3 text-xs font-bold text-slate-200 focus:border-cyan-400/60 focus:outline-none"
              >
                <option value="strength">Signal Score</option>
                <option value="newest">Newest</option>
                <option value="riskReward">Risk/Reward</option>
              </select>
              <button
                onClick={() => setSortDir((d) => (d === "asc" ? "desc" : "asc"))}
                aria-label={sortDir === "desc" ? "Sort descending, activate for ascending" : "Sort ascending, activate for descending"}
                className="inline-flex h-[44px] min-w-[44px] items-center justify-center rounded-xl border border-slate-800 px-3 font-mono text-sm font-bold text-slate-200 hover:bg-slate-900"
              >
                <span aria-hidden="true">{sortDir === "desc" ? "↓" : "↑"}</span>
              </button>
            </span>
          </div>

          <div className="px-4 py-4">
            {scanError !== null ? (
              <div className="py-8 text-center">
                <p className="text-sm font-semibold text-rose-300">
                  Unable to load {category === "stocks" ? "Stocks" : "Commodities"}
                </p>
                <p className="mx-auto mt-1 max-w-md text-xs text-slate-500">
                  Market data is temporarily unavailable.
                </p>
                <button
                  onClick={() => {
                    setStarted(true);
                    setRunId((n) => n + 1);
                  }}
                  className="mt-3 min-h-[44px] rounded-xl border border-slate-700 px-5 text-xs font-bold text-slate-200 hover:bg-slate-800"
                >
                  Retry
                </button>
              </div>
            ) : !summary ? (
              started ? (
                <div role="status" aria-label="Scanning markets">
                  <div aria-hidden="true" className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                    {Array.from({ length: 6 }).map((_, i) => (
                      <div key={i} className="animate-pulse rounded-2xl border border-slate-800 bg-slate-900/70 p-4">
                        <div className="h-5 w-2/5 rounded bg-slate-800" />
                        <div className="mt-3 h-7 w-1/3 rounded bg-slate-800" />
                        <div className="mt-3 grid grid-cols-2 gap-2">
                          <div className="h-12 rounded-xl bg-slate-800/70" />
                          <div className="h-12 rounded-xl bg-slate-800/70" />
                        </div>
                      </div>
                    ))}
                  </div>
                  <span className="sr-only">Scanning markets…</span>
                </div>
              ) : (
                <p className="px-2 py-8 text-center text-sm text-slate-500">
                  {category === "stocks" ? "Stocks" : "Commodities"} selected — press Start Scan when ready.
                </p>
              )
            ) : rows.length === 0 ? (
              <p className="px-2 py-8 text-center text-sm text-slate-500">
                {summary.scanned === 0 ? "No supported markets found." : "No signals match these filters."}
              </p>
            ) : (
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                {rows.map((r) => (
                  <SignalCard
                    key={r.symbol}
                    r={r}
                    market={prices.get(r.symbol) ?? null}
                    watched={watchlist.includes(r.symbol)}
                    onToggleStar={toggleStar}
                  />
                ))}
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-800/80 px-4 py-3 text-xs text-slate-500">
            <span aria-live="polite" className="min-w-0 break-words">
              Showing {filtered.length === 0 ? 0 : safePage * PAGE_SIZE + 1}–{Math.min(filtered.length, safePage * PAGE_SIZE + PAGE_SIZE)} of {filtered.length}
            </span>
            <div className="flex items-center gap-2">
              <button disabled={safePage === 0} onClick={() => setPage((p) => Math.max(0, p - 1))} aria-label="Previous page" className="min-h-[44px] rounded-lg border border-slate-800 px-4 font-bold text-slate-300 disabled:opacity-40 hover:bg-slate-900">← <span className="hidden sm:inline">Previous</span></button>
              <span aria-live="polite">{safePage + 1} / {pageCount}</span>
              <button disabled={safePage >= pageCount - 1} onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))} aria-label="Next page" className="min-h-[44px] rounded-lg border border-slate-800 px-4 font-bold text-slate-300 disabled:opacity-40 hover:bg-slate-900"><span className="hidden sm:inline">Next</span> →</button>
            </div>
          </div>
        </Card>
      )}

      {marketError && (
        <p className="mt-3 rounded-xl border border-amber-400/25 bg-amber-400/[0.06] px-4 py-2.5 text-xs break-words text-amber-200">{marketError}</p>
      )}
    </div>
  );
}
