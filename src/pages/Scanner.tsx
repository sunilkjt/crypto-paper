import { useCallback, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Search } from "lucide-react";
import { Card, CardHeader, PageHeader } from "../components/ui";
import { AiStatusBadge } from "../components/AiStatusBadge";
import { FilterGroup, SignalCard, strengthBand } from "../components/SignalCard";
import { FreshnessLabel } from "../components/LiveBadge";
import { ConnectionBadge } from "../components/ConnectionBadge";
import { timeAgo } from "../components/NewsList";
import { useMarkets } from "../market/store";
import type { ConnectionState } from "../market/connection";
import { REFRESH_OPTIONS, UNIVERSE_OPTIONS, useScan } from "../scanner";
import type { Timeframe } from "../market/hyperliquid/types";
import type { SetupType } from "../signals/setupType";
import { classifyMarket, type MarketCategory } from "../market/classify";
import { addWatched, isWatched, loadWatchlist, removeWatched } from "../alerts/watchlist";
import { cn } from "../lib/cn";

type CategoryTab = "ALL" | MarketCategory;

function parseCategoryTab(v: string | null): CategoryTab {
  return v === "crypto" || v === "stocks" || v === "commodities" ? v : "ALL";
}

type SortKey = "strength" | "newest" | "riskReward" | "dayVolumeNotional" | "dayChangePct" | "rsi" | "fundingRate";
type DirectionFilter = "ALL" | "LONG" | "SHORT" | "WAIT";
type SetupFilter = "ALL" | SetupType;
type StrengthFilter = "ALL" | "WATCH" | "SETUP" | "STRONG" | "HIGH";
type VolumeFilter = "ALL" | "HIGH" | "NORMAL" | "LOW";

const PAGE_SIZE = 25;

const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: "strength", label: "Signal Score" },
  { value: "newest", label: "Newest" },
  { value: "riskReward", label: "Risk/Reward" },
  { value: "dayVolumeNotional", label: "Volume" },
  { value: "dayChangePct", label: "24h Change" },
  { value: "rsi", label: "RSI" },
  { value: "fundingRate", label: "Funding" },
];

/** TFs agreeing with the signal side (agreement beyond dust). */
export function mtfAgreementCount(
  tfs: { agreement: number | null }[],
  direction: "LONG" | "SHORT" | "WAIT",
): string {
  if (direction === "WAIT") return "—";
  const want = direction === "LONG" ? 1 : -1;
  const n = tfs.filter((t) => t.agreement !== null && Math.sign(t.agreement) === want && Math.abs(t.agreement) > 0.2).length;
  return `${n}/${tfs.length}`;
}

export default function Scanner() {
  const { markets, error, updatedAt, connection } = useMarkets();
  const {
    summary, scanning, progress, setupTimeframe, setSetupTimeframe,
    universeSize, setUniverseSize, refreshMs, setRefreshMs, refresh, pausedStale,
  } = useScan();

  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("strength");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [page, setPage] = useState(0);
  const [dirFilter, setDirFilter] = useState<DirectionFilter>("ALL");
  const [setupFilter, setSetupFilter] = useState<SetupFilter>("ALL");
  const [strengthFilter, setStrengthFilter] = useState<StrengthFilter>("ALL");
  const [volFilter, setVolFilter] = useState<VolumeFilter>("ALL");
  const [starredOnly, setStarredOnly] = useState(false);
  const [watchlist, setWatchlist] = useState<string[]>(() => loadWatchlist());
  // Category tab persisted in the hash URL (#/scanner?category=stocks) so a
  // refresh keeps the filter. Default ALL preserves today's full view.
  const [searchParams, setSearchParams] = useSearchParams();
  const [catTab, setCatTab] = useState<CategoryTab>(() => parseCategoryTab(searchParams.get("category")));

  const toggleStar = useCallback((symbol: string) => {
    setWatchlist((list) => (isWatched(symbol, list) ? removeWatched(symbol) : addWatched(symbol)));
  }, []);

  const prices = useMemo(() => new Map(markets.map((m) => [m.symbol, m])), [markets]);
  const mainSymbols = useMemo(
    () => new Set(markets.filter((m) => !m.symbol.includes(":")).map((m) => m.symbol.toUpperCase())),
    [markets],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toUpperCase();
    let rows = summary?.results ?? [];
    if (q) rows = rows.filter((r) => r.symbol.includes(q));
    if (starredOnly) rows = rows.filter((r) => watchlist.includes(r.symbol));
    if (catTab !== "ALL") rows = rows.filter((r) => classifyMarket(r.symbol, mainSymbols) === catTab);
    if (dirFilter !== "ALL") rows = rows.filter((r) => r.signal.direction === dirFilter);
    if (setupFilter !== "ALL") rows = rows.filter((r) => r.setupType === setupFilter);
    if (strengthFilter !== "ALL") {
      rows = rows.filter((r) => {
        const band = strengthBand(r.signal.classification);
        if (strengthFilter === "HIGH") return band === "HIGH" || band === "STRONG";
        return band === strengthFilter;
      });
    }
    if (volFilter !== "ALL") rows = rows.filter((r) => r.signal.volume === volFilter);
    const dir = sortDir === "asc" ? 1 : -1;
    // Nulls always sort last (missing data never outranks real values).
    const cmpNull = (av: number | null, bv: number | null) => {
      if (av === null && bv === null) return 0;
      if (av === null) return 1;
      if (bv === null) return -1;
      return (av - bv) * dir;
    };
    return [...rows].sort((a, b) => {
      switch (sortKey) {
        case "strength":
          return (a.signal.signalStrength - b.signal.signalStrength) * dir;
        case "newest":
          return (a.signal.timestamp - b.signal.timestamp) * dir;
        case "riskReward":
          return cmpNull(a.signal.riskReward, b.signal.riskReward);
        case "dayChangePct":
          return cmpNull(prices.get(a.symbol)?.dayChangePct ?? null, prices.get(b.symbol)?.dayChangePct ?? null);
        case "dayVolumeNotional":
          return cmpNull(prices.get(a.symbol)?.dayVolumeNotional ?? null, prices.get(b.symbol)?.dayVolumeNotional ?? null);
        case "rsi":
          return cmpNull(a.signal.rsi, b.signal.rsi);
        case "fundingRate":
          return cmpNull(prices.get(a.symbol)?.fundingRate ?? null, prices.get(b.symbol)?.fundingRate ?? null);
      }
    });
  }, [summary, query, starredOnly, watchlist, catTab, mainSymbols, dirFilter, setupFilter, strengthFilter, volFilter, sortKey, sortDir, prices]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const rows = filtered.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);

  const setFilterAndPage = <T,>(setter: (v: T) => void, v: T) => {
    setter(v);
    setPage(0);
  };

  const pickCatTab = (c: CategoryTab) => {
    setCatTab(c);
    setPage(0);
    setSearchParams(c === "ALL" ? {} : { category: c }, { replace: true });
  };

  const filtersActive =
    query.trim() !== "" ||
    catTab !== "ALL" ||
    dirFilter !== "ALL" ||
    setupFilter !== "ALL" ||
    strengthFilter !== "ALL" ||
    volFilter !== "ALL" ||
    starredOnly;

  const clearFilters = () => {
    setQuery("");
    setCatTab("ALL");
    setSearchParams({}, { replace: true });
    setDirFilter("ALL");
    setSetupFilter("ALL");
    setStrengthFilter("ALL");
    setVolFilter("ALL");
    setStarredOnly(false);
    setPage(0);
  };

  const validSetups = (summary?.results ?? []).filter((r) => r.signal.direction !== "WAIT").length;
  const autoOn = refreshMs > 0;
  const refreshLabel = REFRESH_OPTIONS.find((o) => o.ms === refreshMs)?.label ?? "";

  return (
    <div>
      <PageHeader
        title="Market Scanner"
        description="Every eligible market scored deterministically. Ranked by Signal Strength — rank is confluence, never investment advice."
        right={
          <div className="flex flex-wrap items-center gap-2">
            <FeedStatus connection={connection} />
            <AiStatusBadge />
            <FreshnessLabel updatedAt={updatedAt} />
            <ConnectionBadge />
          </div>
        }
      />

      <Card>
        <CardHeader
          title="HIGH-CONFLUENCE SETUPS"
          subtitle={`${summary?.scanned ?? 0} scanned · ${summary?.excluded.length ?? 0} excluded · ${validSetups} valid setups · setup TF ${setupTimeframe}`}
          right={
            <span className="text-[11px] text-slate-500">
              {scanning ? `SCANNING ${progress.done}/${progress.total}` : summary ? `COMPLETE · ${timeAgo(summary.completedAt)}` : pausedStale ? "PAUSED · DATA STALE" : "STARTING…"}
            </span>
          }
        />

        {/* Refresh + universe + timeframe controls */}
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-800/70 px-4 py-3 text-xs">
          <span className="font-bold tracking-widest text-slate-500 uppercase">Refresh</span>
          {REFRESH_OPTIONS.map((o) => (
            <button
              key={o.label}
              onClick={() => setRefreshMs(o.ms)}
              aria-pressed={refreshMs === o.ms}
              className={cn("min-h-[44px] rounded-lg border px-3 font-bold", refreshMs === o.ms ? "border-cyan-400/50 bg-cyan-400/10 text-cyan-200" : "border-slate-800 text-slate-400 hover:border-slate-700")}
            >
              {o.label === "OFF" ? "OFF" : o.label}
            </button>
          ))}
          <span
            className={cn("inline-flex min-h-[44px] items-center gap-1.5 rounded-lg border px-3 font-bold", autoOn ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-300" : "border-slate-800 text-slate-500")}
            title={autoOn ? `Rescans every ${refreshLabel}` : "Background rescans paused"}
          >
            <span aria-hidden="true">{autoOn ? "●" : "○"}</span> Auto refresh {autoOn ? "ON" : "OFF"}
          </span>
          <span className="ml-2 font-bold tracking-widest text-slate-500 uppercase">TF</span>
          {(["5m", "15m", "1h", "4h"] as Timeframe[]).map((t) => (
            <button
              key={t}
              onClick={() => setSetupTimeframe(t)}
              aria-pressed={setupTimeframe === t}
              className={cn("min-h-[44px] rounded-lg border px-3 font-bold", setupTimeframe === t ? "border-cyan-400/50 bg-cyan-400/10 text-cyan-200" : "border-slate-800 text-slate-400 hover:border-slate-700")}
            >
              {t}
            </button>
          ))}
          <span className="ml-2 font-bold tracking-widest text-slate-500 uppercase">Universe</span>
          {UNIVERSE_OPTIONS.map((n) => (
            <button
              key={n}
              onClick={() => setUniverseSize(n)}
              aria-pressed={universeSize === n}
              className={cn("min-h-[44px] rounded-lg border px-3 font-bold", universeSize === n ? "border-cyan-400/50 bg-cyan-400/10 text-cyan-200" : "border-slate-800 text-slate-400 hover:border-slate-700")}
            >
              {n}
            </button>
          ))}
          <button onClick={refresh} className="ml-auto min-h-[44px] rounded-lg border border-slate-700 px-4 font-bold text-slate-200 hover:bg-slate-800">
            Rescan
          </button>
        </div>

        {/* Filters */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-slate-800/70 px-4 py-3 text-xs">
          <FilterGroup
            label="Category"
            options={["ALL", "CRYPTO", "STOCKS", "COMMODITIES"]}
            value={catTab === "ALL" ? "ALL" : catTab.toUpperCase()}
            onPick={(v) => pickCatTab(v === "ALL" ? "ALL" : (v.toLowerCase() as MarketCategory))}
          />
          <FilterGroup label="Direction" options={["ALL", "LONG", "SHORT", "WAIT"]} value={dirFilter} onPick={(v) => setFilterAndPage(setDirFilter, v as DirectionFilter)} />
          <FilterGroup label="Setup" options={["ALL", "BOUNCE", "BREAKOUT", "BREAKDOWN", "PULLBACK", "REVERSAL", "TREND", "RANGE"]} value={setupFilter} onPick={(v) => setFilterAndPage(setSetupFilter, v as SetupFilter)} />
          <FilterGroup label="Strength" options={["ALL", "WATCH", "SETUP", "STRONG", "HIGH"]} value={strengthFilter} onPick={(v) => setFilterAndPage(setStrengthFilter, v as StrengthFilter)} />
          <FilterGroup label="Volume" options={["ALL", "HIGH", "NORMAL", "LOW"]} value={volFilter} onPick={(v) => setFilterAndPage(setVolFilter, v as VolumeFilter)} />
          <button
            onClick={() => setFilterAndPage(setStarredOnly, !starredOnly)}
            aria-pressed={starredOnly}
            title="Show only watchlisted coins"
            className={cn("inline-flex min-h-[44px] items-center gap-1 rounded-lg border px-3 font-bold", starredOnly ? "border-amber-400/50 bg-amber-400/10 text-amber-200" : "border-slate-800 text-slate-500 hover:border-slate-700")}
          >
            <span aria-hidden="true">{starredOnly ? "★" : "☆"}</span> Starred
          </button>
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
            <label htmlFor="scan-sort" className="font-bold tracking-widest text-slate-500 uppercase">Sort</label>
            <select
              id="scan-sort"
              value={sortKey}
              onChange={(e) => setFilterAndPage(setSortKey, e.target.value as SortKey)}
              className="h-[44px] rounded-xl border border-slate-800 bg-slate-950 px-3 text-xs font-bold text-slate-200 focus:border-cyan-400/60 focus:outline-none"
            >
              {SORT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
            <button
              onClick={() => setSortDir((d) => (d === "asc" ? "desc" : "asc"))}
              aria-label={sortDir === "desc" ? "Sort descending, activate for ascending" : "Sort ascending, activate for descending"}
              title={sortDir === "desc" ? "Highest first" : "Lowest first"}
              className="inline-flex h-[44px] min-w-[44px] items-center justify-center rounded-xl border border-slate-800 px-3 font-mono text-sm font-bold text-slate-200 hover:bg-slate-900"
            >
              <span aria-hidden="true">{sortDir === "desc" ? "↓" : "↑"}</span>
            </button>
          </span>
        </div>

        <div className="px-4 py-4">
          {summary?.status === "ERROR" && (summary?.results.length ?? 0) === 0 ? (
            <div className="py-8 text-center">
              <p className="text-sm font-semibold text-rose-300">Unable to load signals</p>
              <p className="mx-auto mt-1 max-w-md text-xs text-slate-500">
                Market data connection is temporarily unavailable. Your filters and watchlist are untouched.
              </p>
              <button onClick={refresh} className="mt-3 min-h-[44px] rounded-xl border border-slate-700 px-5 text-xs font-bold text-slate-200 hover:bg-slate-800">
                Retry
              </button>
            </div>
          ) : !summary ? (
            <SkeletonGrid />
          ) : rows.length === 0 ? (
            filtersActive ? (
              <div className="py-8 text-center">
                <p className="text-sm font-semibold text-slate-200">No signals match these filters.</p>
                <button onClick={clearFilters} className="mt-3 min-h-[44px] rounded-xl border border-slate-700 px-5 text-xs font-bold text-slate-200 hover:bg-slate-800">
                  Clear filters
                </button>
              </div>
            ) : (
              <div className="py-8 text-center">
                <p className="text-sm font-semibold text-slate-200">No active signals</p>
                <p className="mx-auto mt-1 max-w-md text-xs text-slate-500">
                  The scanner is monitoring the market.{" "}
                  {autoOn ? `Auto refresh is ON — rescans every ${refreshLabel}.` : "Auto refresh is OFF — press Rescan anytime."}
                </p>
              </div>
            )
          ) : (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              {rows.map((r) => (
                <SignalCard
                  key={r.symbol}
                  r={r}
                  market={prices.get(r.symbol) ?? null}
                  watched={watchlist.includes(r.symbol)}
                  onToggleStar={toggleStar}
                  mainSymbols={mainSymbols}
                />
              ))}
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-800/80 px-4 py-3 text-xs text-slate-500">
          <span className="min-w-0 break-words">
            {summary ? (
              <>Last full scan: {timeAgo(summary.completedAt)} · {summary.scanned} scanned · {summary.excluded.length} excluded · {validSetups} valid setups</>
            ) : (
              "Preparing first scan…"
            )}
          </span>
          <div className="flex items-center gap-2">
            <button disabled={safePage === 0} onClick={() => setPage((p) => Math.max(0, p - 1))} className="min-h-[44px] rounded-lg border border-slate-800 px-4 font-bold text-slate-300 disabled:opacity-40 hover:bg-slate-900">Prev</button>
            <span aria-live="polite">{safePage + 1} / {pageCount}</span>
            <button disabled={safePage >= pageCount - 1} onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))} className="min-h-[44px] rounded-lg border border-slate-800 px-4 font-bold text-slate-300 disabled:opacity-40 hover:bg-slate-900">Next</button>
          </div>
        </div>
      </Card>

      {error && (
        <p className="mt-3 rounded-xl border border-amber-400/25 bg-amber-400/[0.06] px-4 py-2.5 text-xs break-words text-amber-200">{error}</p>
      )}
    </div>
  );
}

/** Feed freshness pill: LIVE / STARTING / STALE / OFFLINE from market connection. */
function FeedStatus({ connection }: { connection: ConnectionState }) {
  const meta =
    connection === "ONLINE"
      ? { dot: "bg-emerald-400", emoji: "🟢", label: "LIVE" }
      : connection === "OFFLINE"
        ? { dot: "bg-rose-500", emoji: "🔴", label: "OFFLINE" }
        : connection === "DEGRADED" || connection === "RATE_LIMITED"
          ? { dot: "bg-orange-400", emoji: "🟠", label: "STALE" }
          : { dot: "bg-amber-300", emoji: "🟡", label: "STARTING" };
  return (
    <span
      className="inline-flex min-h-[28px] items-center gap-1.5 rounded-full border border-slate-800 bg-slate-900 px-3 py-1 text-[11px] font-bold text-slate-300"
      title={`Market feed: ${meta.label}`}
    >
      <span className={cn("h-1.5 w-1.5 rounded-full", meta.dot)} />
      <span aria-hidden="true">{meta.emoji}</span>
      {meta.label}
    </span>
  );
}

function SkeletonGrid() {
  return (
    <div role="status" aria-label="Loading signals">
      <div aria-hidden="true" className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="animate-pulse rounded-2xl border border-slate-800 bg-slate-900/70 p-4">
            <div className="h-5 w-2/5 rounded bg-slate-800" />
            <div className="mt-3 flex justify-between">
              <div className="h-7 w-1/3 rounded bg-slate-800" />
              <div className="h-5 w-1/4 rounded bg-slate-800" />
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <div className="h-12 rounded-xl bg-slate-800/70" />
              <div className="h-12 rounded-xl bg-slate-800/70" />
              <div className="h-12 rounded-xl bg-slate-800/70" />
              <div className="h-12 rounded-xl bg-slate-800/70" />
            </div>
            <div className="mt-3 h-4 w-3/4 rounded bg-slate-800" />
            <div className="mt-1.5 h-4 w-1/2 rounded bg-slate-800" />
          </div>
        ))}
      </div>
      <span className="sr-only">Loading signals…</span>
    </div>
  );
}
