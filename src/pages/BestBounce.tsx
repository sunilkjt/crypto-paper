import { useMemo } from "react";
import { Link } from "react-router-dom";
import { Card, CardHeader, EmptyState, PageHeader } from "../components/ui";
import { ConnectionBadge, ConnectionLine } from "../components/ConnectionBadge";
import { FreshnessLabel } from "../components/LiveBadge";
import { timeAgo } from "../components/NewsList";
import { useMarkets } from "../market/store";
import { isListableBounce } from "../analysis/signal";
import { REFRESH_OPTIONS, useScan } from "../scanner";
import { useNewsBatch } from "../news/useNews";
import { formatPriceUsd } from "../lib/format";
import { cn } from "../lib/cn";

function fmt(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US", { maximumFractionDigits: 4 });
}

export default function BestBounce() {
  const { markets, error, updatedAt } = useMarkets();
  const {
    summary, scanning, progress, setupTimeframe,
    refreshMs, setRefreshMs, refresh, pausedStale,
  } = useScan();

  const setups = useMemo(() => {
    const prices = new Map(markets.map((m) => [m.symbol, m.markPrice]));
    return (summary?.results ?? [])
      .filter((r) => isListableBounce(r.signal))
      .map((r) => ({ signal: r.signal, setupType: r.setupType, quality: r.quality, price: prices.get(r.symbol) ?? null }));
  }, [summary, markets]);

  const catalystBySymbol = useNewsBatch(useMemo(() => setups.map((s) => s.signal.symbol), [setups]));

  return (
    <div>
      <PageHeader
        title="BEST BOUNCE"
        description="Potential bounce setups: support, RSI recovery, MACD improvement, volume confirmation, structure, and higher/lower timeframe alignment."
        right={
          <div className="flex items-center gap-2">
            <ConnectionBadge />
          </div>
        }
      />
      <p className="mb-3 text-xs leading-relaxed text-slate-500">
        Bounce-focused setups from the shared browser scan. The full ranked list lives under{" "}
        <Link to="/scanner" className="font-bold text-cyan-300 hover:underline">Scanner</Link>
        {" "}· broader Stocks/Commodities coverage under <Link to="/markets" className="font-bold text-cyan-300 hover:underline">Markets</Link>.
      </p>

      <Card>
        <CardHeader
          title={`Bounce Scan · full eligible universe (${setupTimeframe} setup)`}
          subtitle="Bounce detector + signal agreement required — no invented setups"
          right={<ConnectionLine />}
        />
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-800/70 px-4 py-3 text-xs text-slate-400">
          {pausedStale ? (
            <span className="font-bold text-amber-300">DATA STALE — scanning paused until the feed recovers.</span>
          ) : scanning ? (
            <span>
              Scoring {progress.done}/{progress.total} markets…
              <span className="ml-2 inline-block h-3 w-40 overflow-hidden rounded-full bg-slate-800 align-middle">
                <span
                  className="block h-full bg-cyan-400 transition-all"
                  style={{ width: progress.total > 0 ? `${(progress.done / progress.total) * 100}%` : "0%" }}
                />
              </span>
            </span>
          ) : summary ? (
            <span>
              {summary.scanned} scored · {setups.length} bounce setup{setups.length === 1 ? "" : "s"} ·{" "}
              last scan {timeAgo(summary.completedAt)}
            </span>
          ) : (
            <span>Preparing scan…</span>
          )}
          <span className="ml-auto flex items-center gap-2">
            <FreshnessLabel updatedAt={updatedAt} />
            {REFRESH_OPTIONS.map((o) => (
              <button
                key={o.label}
                onClick={() => setRefreshMs(o.ms)}
                className={cn("rounded-lg border px-2 py-1 font-bold", refreshMs === o.ms ? "border-cyan-400/50 bg-cyan-400/10 text-cyan-200" : "border-slate-800 text-slate-500 hover:border-slate-700")}
              >
                {o.label === "OFF" ? "OFF" : o.label}
              </button>
            ))}
            <button onClick={refresh} className="rounded-lg border border-slate-700 px-3 py-1 font-bold text-slate-200 hover:bg-slate-800">
              Rescan
            </button>
          </span>
        </div>

        {pausedStale ? (
          <EmptyState
            title="DATA STALE"
            message="Market data is stale, so no fresh scan is produced. Last results are withheld rather than presented as live."
            hint="Wait for the feed or press Rescan"
          />
        ) : scanning && setups.length === 0 ? (
          <EmptyState title="Scanning markets…" message="Scoring every eligible market across 4H/1H/15M/5M." />
        ) : setups.length === 0 ? (
          <EmptyState
            title="No high-confluence bounce setups currently detected."
            message="Scored markets lack the multi-confirmation agreement a bounce requires (level + recovery + momentum + volume + timeframe alignment). Nothing is invented to fill this table."
            hint={`Scanned ${summary?.scanned ?? 0} markets · all below bar`}
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-sm" style={{ minWidth: 1220 }}>
              <thead>
                <tr className="border-b border-slate-800 text-[11px] tracking-widest text-slate-500 uppercase">
                  {["Coin", "Price", "Bounce", "Score", "Dir", "Entry", "Invalidation", "TP1", "TP2", "TP3", "R:R", "Catalyst", "Components"].map((c) => (
                    <th key={c} className="px-3 py-3 font-semibold whitespace-nowrap">{c}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {setups.map(({ signal: s, setupType, quality, price }) => (
                  <tr key={s.symbol} className="border-b border-slate-800/50 last:border-0 hover:bg-slate-900/50">
                    <td className="px-3 py-2.5">
                      <Link to={`/coin/${s.symbol}`} className="font-bold text-white hover:text-cyan-300">
                        {s.symbol}
                      </Link>
                      <span className="ml-2 rounded-full bg-cyan-400/10 px-2 py-0.5 text-[10px] font-bold text-cyan-300">
                        {s.classification}
                      </span>
                      <span className="ml-1 rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[10px] text-slate-400" title={`Quality: ${quality}`}>
                        {setupType}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 font-mono text-slate-200">{formatPriceUsd(price, s.symbol)}</td>
                    <td className="px-3 py-2.5 font-mono font-bold text-cyan-200" title="Bounce checklist score (components below)">
                      {s.bounce?.bounceScore ?? "—"}
                    </td>
                    <td className="px-3 py-2.5 font-mono font-bold text-slate-100">{s.signalStrength}</td>
                    <td className="px-3 py-2.5">
                      <span className={cn("inline-flex rounded-md border px-2 py-0.5 text-[11px] font-bold", s.direction === "LONG" && "border-emerald-400/30 bg-emerald-400/10 text-emerald-300", s.direction === "SHORT" && "border-rose-400/30 bg-rose-400/10 text-rose-300")}>
                        {s.direction}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 font-mono text-xs text-slate-300">{s.entryLow !== null ? `${fmt(s.entryLow)}–${fmt(s.entryHigh)}` : "—"}</td>
                    <td className="px-3 py-2.5 font-mono text-xs text-slate-300">{fmt(s.invalidation)}</td>
                    <td className="px-3 py-2.5 font-mono text-xs text-slate-300">{fmt(s.tp1)}</td>
                    <td className="px-3 py-2.5 font-mono text-xs text-slate-300">{fmt(s.tp2)}</td>
                    <td className="px-3 py-2.5 font-mono text-xs text-slate-300">{fmt(s.tp3)}</td>
                    <td className="px-3 py-2.5 font-mono text-xs text-slate-200">{s.riskReward !== null ? `1:${s.riskReward}` : "—"}</td>
                    <td className="max-w-[200px] px-3 py-2.5 text-[11px] leading-snug">
                      {(() => {
                        const item = catalystBySymbol.get(s.symbol);
                        if (!item) return <span className="text-slate-600">Catalyst: None found</span>;
                        const positive = item.sentiment === "POSITIVE";
                        const negative = item.sentiment === "NEGATIVE";
                        return (
                          <a href={item.url} target="_blank" rel="noopener noreferrer" title={`${item.headline} (${item.source})`}
                            className={cn("font-semibold hover:underline", positive && "text-emerald-300", negative && "text-rose-300", !positive && !negative && "text-slate-300")}>
                            Recent {positive ? "positive" : negative ? "negative" : "neutral"} catalyst
                          </a>
                        );
                      })()}
                    </td>
                    <td className="max-w-[260px] px-3 py-2.5 font-mono text-[11px] leading-snug text-slate-400" title="Bounce checklist parts: support/25 momentum/35 volume/15 structure/5 mtf/25">
                      {s.bounce ? `S${s.bounce.components.support} M${s.bounce.components.momentum} V${s.bounce.components.volume} T${s.bounce.components.structure} F${s.bounce.components.mtf}` : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {error && (
        <p className="mt-3 rounded-xl border border-amber-400/25 bg-amber-400/[0.06] px-4 py-2.5 text-xs text-amber-200">{error}</p>
      )}

      <Card className="mt-4">
        <CardHeader title="How bounce scoring works" subtitle="Checklist 0–100, never a probability" />
        <div className="grid gap-3 p-5 text-xs leading-relaxed text-slate-400 sm:grid-cols-2 lg:grid-cols-5">
          {[
            ["Support · 25", "Price within 1 ATR of a scored support zone."],
            ["Momentum · 35", "RSI weakness-then-recovery plus MACD improvement."],
            ["Volume · 15", "Relative-volume confirmation, spikes weigh more."],
            ["Structure · 5", "HH/HL or LH/LL agreement with the bounce side."],
            ["MTF · 25", "5M reversal turn plus a non-hostile 4H."],
          ].map(([t, d]) => (
            <div key={t} className="rounded-xl border border-slate-800 bg-slate-950/60 p-3">
              <p className="font-bold text-slate-200">{t}</p>
              <p className="mt-1">{d}</p>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
