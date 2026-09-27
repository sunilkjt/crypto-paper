import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowDown, ArrowUp, ArrowUpDown, Search } from "lucide-react";
import { Card, CardHeader, PageHeader } from "../components/ui";
import { FreshnessLabel } from "../components/LiveBadge";
import { ConnectionBadge } from "../components/ConnectionBadge";
import { timeAgo } from "../components/NewsList";
import { useMarkets } from "../market/store";
import { REFRESH_OPTIONS, UNIVERSE_OPTIONS, useScan } from "../scanner";
import type { Timeframe } from "../market/hyperliquid/types";
import { formatChangePct, formatPrice } from "../lib/format";
import { formatFundingRate } from "../market/hyperliquid/funding";
import { formatOpenInterestNotional } from "../market/hyperliquid/openInterest";
import type { SetupType } from "../signals/setupType";
import type { StrengthClass } from "../analysis/scoring";
import { cn } from "../lib/cn";

type SortKey = "strength" | "dayChangePct" | "dayVolumeNotional" | "rsi" | "fundingRate" | "openInterestNotional";
type DirectionFilter = "ALL" | "LONG" | "SHORT" | "WAIT";
type SetupFilter = "ALL" | SetupType;
type StrengthFilter = "ALL" | "WATCH" | "SETUP" | "STRONG" | "HIGH";
type VolumeFilter = "ALL" | "HIGH" | "NORMAL" | "LOW";

const PAGE_SIZE = 25;

function strengthBand(s: StrengthClass): "WATCH" | "SETUP" | "STRONG" | "HIGH" | "WAIT" {
  if (s === "HIGH-CONFLUENCE SETUP") return "HIGH";
  if (s === "STRONG SETUP") return "STRONG";
  if (s === "SETUP") return "SETUP";
  if (s === "WATCH") return "WATCH";
  return "WAIT";
}

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
  const { markets, error, updatedAt } = useMarkets();
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

  const prices = useMemo(() => new Map(markets.map((m) => [m.symbol, m])), [markets]);

  const filtered = useMemo(() => {
    const q = query.trim().toUpperCase();
    let rows = summary?.results ?? [];
    if (q) rows = rows.filter((r) => r.symbol.includes(q));
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
    return [...rows].sort((a, b) => {
      switch (sortKey) {
        case "strength":
          return (a.signal.signalStrength - b.signal.signalStrength) * dir;
        case "dayChangePct":
          return ((prices.get(a.symbol)?.dayChangePct ?? -Infinity) - (prices.get(b.symbol)?.dayChangePct ?? -Infinity)) * dir;
        case "dayVolumeNotional":
          return ((prices.get(a.symbol)?.dayVolumeNotional ?? -Infinity) - (prices.get(b.symbol)?.dayVolumeNotional ?? -Infinity)) * dir;
        case "rsi":
          return ((a.signal.rsi ?? -Infinity) - (b.signal.rsi ?? -Infinity)) * dir;
        case "fundingRate":
          return ((prices.get(a.symbol)?.fundingRate ?? -Infinity) - (prices.get(b.symbol)?.fundingRate ?? -Infinity)) * dir;
        case "openInterestNotional":
          return ((prices.get(a.symbol)?.openInterestNotional ?? -Infinity) - (prices.get(b.symbol)?.openInterestNotional ?? -Infinity)) * dir;
      }
    });
  }, [summary, query, dirFilter, setupFilter, strengthFilter, volFilter, sortKey, sortDir, prices]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const rows = filtered.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);

  const toggleSort = (key: SortKey) => {
    setPage(0);
    if (key === sortKey) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir("desc");
    }
  };

  const setFilterAndPage = <T,>(setter: (v: T) => void, v: T) => {
    setter(v);
    setPage(0);
  };

  const validSetups = (summary?.results ?? []).filter((r) => r.signal.direction !== "WAIT").length;

  return (
    <div>
      <PageHeader
        title="Market Scanner"
        description="Every eligible market scored deterministically. Ranked by Signal Strength — rank is confluence, never investment advice."
        right={
          <div className="flex items-center gap-2">
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
              className={cn("rounded-lg border px-2.5 py-1 font-bold", refreshMs === o.ms ? "border-cyan-400/50 bg-cyan-400/10 text-cyan-200" : "border-slate-800 text-slate-400 hover:border-slate-700")}
            >
              {o.label === "OFF" ? "OFF" : o.label}
            </button>
          ))}
          <span className="ml-2 font-bold tracking-widest text-slate-500 uppercase">TF</span>
          {(["5m", "15m", "1h", "4h"] as Timeframe[]).map((t) => (
            <button
              key={t}
              onClick={() => setSetupTimeframe(t)}
              className={cn("rounded-lg border px-2.5 py-1 font-bold", setupTimeframe === t ? "border-cyan-400/50 bg-cyan-400/10 text-cyan-200" : "border-slate-800 text-slate-400 hover:border-slate-700")}
            >
              {t}
            </button>
          ))}
          <span className="ml-2 font-bold tracking-widest text-slate-500 uppercase">Universe</span>
          {UNIVERSE_OPTIONS.map((n) => (
            <button
              key={n}
              onClick={() => setUniverseSize(n)}
              className={cn("rounded-lg border px-2.5 py-1 font-bold", universeSize === n ? "border-cyan-400/50 bg-cyan-400/10 text-cyan-200" : "border-slate-800 text-slate-400 hover:border-slate-700")}
            >
              {n}
            </button>
          ))}
          <button onClick={refresh} className="ml-auto rounded-lg border border-slate-700 px-3 py-1 font-bold text-slate-200 hover:bg-slate-800">
            Rescan
          </button>
        </div>

        {/* Filters */}
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-800/70 px-4 py-3 text-xs">
          <FilterGroup label="Direction" options={["ALL", "LONG", "SHORT", "WAIT"]} value={dirFilter} onPick={(v) => setFilterAndPage(setDirFilter, v as DirectionFilter)} />
          <FilterGroup label="Setup" options={["ALL", "BOUNCE", "BREAKOUT", "BREAKDOWN", "PULLBACK", "REVERSAL", "TREND", "RANGE"]} value={setupFilter} onPick={(v) => setFilterAndPage(setSetupFilter, v as SetupFilter)} />
          <FilterGroup label="Strength" options={["ALL", "WATCH", "SETUP", "STRONG", "HIGH"]} value={strengthFilter} onPick={(v) => setFilterAndPage(setStrengthFilter, v as StrengthFilter)} />
          <FilterGroup label="Volume" options={["ALL", "HIGH", "NORMAL", "LOW"]} value={volFilter} onPick={(v) => setFilterAndPage(setVolFilter, v as VolumeFilter)} />
          <label className="relative ml-auto min-w-[180px] flex-1 sm:max-w-[240px]">
            <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-slate-500" />
            <input
              value={query}
              onChange={(e) => setFilterAndPage(setQuery, e.target.value)}
              placeholder="Search: OP…"
              className="w-full rounded-xl border border-slate-800 bg-slate-950 py-1.5 pr-3 pl-9 text-xs text-slate-100 placeholder:text-slate-600 focus:border-cyan-400/60 focus:outline-none"
            />
          </label>
        </div>

        {summary?.status === "ERROR" && summary.results.length === 0 ? (
          <div className="px-4 py-12 text-center">
            <p className="text-sm font-semibold text-rose-300">{summary.error ?? "Market-data failure."}</p>
            <p className="mt-1 text-xs text-slate-500">The scanner reports the outage — the rest of the app stays up.</p>
            <button onClick={refresh} className="mt-3 rounded-xl border border-slate-700 px-4 py-2 text-xs font-bold text-slate-200 hover:bg-slate-800">
              Retry scan
            </button>
          </div>
        ) : rows.length === 0 ? (
          <p className="px-4 py-12 text-center text-sm text-slate-500">
            {scanning ? "Scoring markets…" : "No rows match these filters."}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-sm" style={{ minWidth: 1180 }}>
              <thead>
                <tr className="border-b border-slate-800 text-[11px] tracking-widest text-slate-500 uppercase">
                  <Th label="Coin" />
                  <Th label="Price" right />
                  <SortTh label="24h%" active={sortKey === "dayChangePct"} dir={sortDir} onClick={() => toggleSort("dayChangePct")} right />
                  <SortTh label="Volume" active={sortKey === "dayVolumeNotional"} dir={sortDir} onClick={() => toggleSort("dayVolumeNotional")} right />
                  <SortTh label="Funding" active={sortKey === "fundingRate"} dir={sortDir} onClick={() => toggleSort("fundingRate")} right />
                  <SortTh label="OI" active={sortKey === "openInterestNotional"} dir={sortDir} onClick={() => toggleSort("openInterestNotional")} right />
                  <Th label="Trend" />
                  <SortTh label="RSI" active={sortKey === "rsi"} dir={sortDir} onClick={() => toggleSort("rsi")} right />
                  <Th label="Momentum" />
                  <Th label="Structure" />
                  <Th label="MTF" />
                  <Th label="Signal" right />
                  <SortTh label="Strength" active={sortKey === "strength"} dir={sortDir} onClick={() => toggleSort("strength")} right />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const m = prices.get(r.symbol);
                  const chg = formatChangePct(m?.dayChangePct ?? null);
                  const s = r.signal;
                  return (
                    <tr key={r.symbol} className="border-b border-slate-800/50 last:border-0 hover:bg-slate-900/50">
                      <td className="px-3 py-2.5">
                        <Link to={`/coin/${r.symbol}`} className="font-bold text-white hover:text-cyan-300">{r.symbol}</Link>
                        <span className="ml-1.5 rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[10px] text-slate-400">{r.setupType}</span>
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono text-slate-200">{m?.markPrice != null ? `$${formatPrice(m.markPrice, r.symbol)}` : "—"}</td>
                      <td className={cn("px-3 py-2.5 text-right font-mono", chg.positive === true && "text-emerald-300", chg.positive === false && "text-rose-300", chg.positive === null && "text-slate-500")}>{chg.text}</td>
                      <td className="px-3 py-2.5 text-right font-mono text-slate-300">{m?.dayVolumeNotional != null ? `$${(m.dayVolumeNotional / 1_000_000).toFixed(1)}M` : "—"}</td>
                      <td className="px-3 py-2.5 text-right font-mono text-slate-300">{formatFundingRate(m?.fundingRate ?? null)}</td>
                      <td className="px-3 py-2.5 text-right font-mono text-slate-300">{formatOpenInterestNotional(m?.openInterestNotional ?? null)}</td>
                      <td className="px-3 py-2.5 text-xs whitespace-nowrap text-slate-300">{s.trend === "INSUFFICIENT" ? "—" : s.trend}</td>
                      <td className="px-3 py-2.5 text-right font-mono text-slate-200">{s.rsi !== null ? s.rsi.toFixed(0) : "—"}</td>
                      <td className="px-3 py-2.5 text-xs whitespace-nowrap text-slate-300">{s.momentum === "INSUFFICIENT" ? "—" : s.momentum}</td>
                      <td className="px-3 py-2.5 text-xs whitespace-nowrap text-slate-300">{s.marketStructure === "INSUFFICIENT" ? "—" : s.marketStructure}</td>
                      <td className="px-3 py-2.5 font-mono text-[11px] whitespace-nowrap text-slate-400">
                        {s.multiTimeframe ? mtfAgreementCount(s.multiTimeframe.tfs, s.direction) : "—"}
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        <span className={cn("inline-flex rounded-md border px-2 py-0.5 text-[11px] font-bold", s.direction === "LONG" && "border-emerald-400/30 bg-emerald-400/10 text-emerald-300", s.direction === "SHORT" && "border-rose-400/30 bg-rose-400/10 text-rose-300", s.direction === "WAIT" && "border-slate-700 bg-slate-800 text-slate-400")}>
                          {s.direction}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono font-bold text-slate-100">{s.signalStrength}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-800/80 px-4 py-3 text-xs text-slate-500">
          <span>
            {summary ? (
              <>Last full scan: {timeAgo(summary.completedAt)} · {summary.scanned} scanned · {summary.excluded.length} excluded · {validSetups} valid setups</>
            ) : (
              "Preparing first scan…"
            )}
          </span>
          <div className="flex items-center gap-2">
            <button disabled={safePage === 0} onClick={() => setPage((p) => Math.max(0, p - 1))} className="rounded-lg border border-slate-800 px-3 py-1.5 font-bold text-slate-300 disabled:opacity-40 hover:bg-slate-900">Prev</button>
            <span>{safePage + 1} / {pageCount}</span>
            <button disabled={safePage >= pageCount - 1} onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))} className="rounded-lg border border-slate-800 px-3 py-1.5 font-bold text-slate-300 disabled:opacity-40 hover:bg-slate-900">Next</button>
          </div>
        </div>
      </Card>

      {error && (
        <p className="mt-3 rounded-xl border border-amber-400/25 bg-amber-400/[0.06] px-4 py-2.5 text-xs text-amber-200">{error}</p>
      )}
    </div>
  );
}

function Th({ label, right = false }: { label: string; right?: boolean }) {
  return <th className={cn("px-3 py-3 font-semibold whitespace-nowrap", right && "text-right")}>{label}</th>;
}

function SortTh({ label, active, dir, onClick, right = false }: { label: string; active: boolean; dir: "asc" | "desc"; onClick: () => void; right?: boolean }) {
  return (
    <th className={cn("px-3 py-3 font-semibold whitespace-nowrap", right && "text-right")}>
      <button onClick={onClick} className="inline-flex items-center gap-1 hover:text-slate-200" title={`Sort by ${label}`}>
        {label}
        {active ? (dir === "asc" ? <ArrowUp className="h-3 w-3 text-cyan-300" /> : <ArrowDown className="h-3 w-3 text-cyan-300" />) : <ArrowUpDown className="h-3 w-3 opacity-40" />}
      </button>
    </th>
  );
}

function FilterGroup({ label, options, value, onPick }: { label: string; options: string[]; value: string; onPick: (v: string) => void }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <span className="font-bold tracking-widest text-slate-500 uppercase">{label}</span>
      {options.map((o) => (
        <button
          key={o}
          onClick={() => onPick(o)}
          className={cn("rounded-lg border px-2 py-1 font-bold", value === o ? "border-cyan-400/50 bg-cyan-400/10 text-cyan-200" : "border-slate-800 text-slate-500 hover:border-slate-700")}
        >
          {o}
        </button>
      ))}
    </span>
  );
}
