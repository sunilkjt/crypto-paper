import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Bitcoin } from "lucide-react";
import {
  Card,
  CardHeader,
  DemoBadge,
  PageHeader,
} from "../components/ui";
import { FreshnessLabel, LiveBadge } from "../components/LiveBadge";
import { CategoryChip } from "../components/SignalCard";
import { ScannerHealthPanel, ServerSignalCounts } from "../components/ScannerHealth";
import { ConnectionBadge } from "../components/ConnectionBadge";
import { timeAgo } from "../components/NewsList";
import { useMarkets } from "../market/store";
import { useScan } from "../scanner";
import { useAuth } from "../supabase/auth";
import { useServerHistory } from "../supabase/history";
import { useTelegramConnection } from "../supabase/telegram";
import { getSharedPaperEngine, unrealizedFor, type PaperSnapshot } from "../paper";
import { loadAlertSettings } from "../alerts";
import { isListableBounce } from "../analysis/signal";
import { loadJournal } from "../signals/journal";
import {
  formatChangePct,
  formatOiCoins,
  formatPriceUsd,
  formatVolumeNotional,
} from "../lib/format";
import { formatFundingRate } from "../market/hyperliquid/funding";
import { summarizeRegime } from "../ai/regime";
import { cn } from "../lib/cn";
import type { Market } from "../market/hyperliquid/types";

const MAJORS = ["BTC", "ETH", "SOL", "HYPE", "DOGE", "LINK", "AVAX", "ARB"];

function RegimeCard({
  title,
  value,
  sub,
  tone,
}: {
  title: string;
  value: string;
  sub: string;
  tone?: "up" | "down" | null;
}) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4">
      <p className="text-[11px] font-semibold tracking-widest text-slate-500 uppercase">
        {title}
      </p>
      <p
        className={cn(
          "mt-1.5 font-mono text-xl font-bold",
          tone === "up" ? "text-emerald-300" : tone === "down" ? "text-rose-300" : "text-white",
        )}
      >
        {value}
      </p>
      <p className="mt-0.5 text-xs text-slate-500">{sub}</p>
    </div>
  );
}

function AiMarketRegime({ markets }: { markets: Market[] }) {
  const regime = summarizeRegime(markets);
  const tone =
    regime.regime === "BULLISH" ? "text-emerald-300" : regime.regime === "BEARISH" ? "text-rose-300" : "text-amber-300";
  return (
    <Card className="mt-4">
      <CardHeader
        title="AI Market Regime"
        subtitle="BTC trend · ETH trend · breadth · chop — supplied data only"
        right={<DemoBadge label="LOCAL" />}
      />
      <div className="px-5 py-4">
        <p className={`text-lg font-extrabold tracking-tight ${tone}`}>
          {regime.regime === "BULLISH" ? "🟢" : regime.regime === "BEARISH" ? "🔴" : "🟡"} {regime.regime}
        </p>
        <p className="mt-1 max-w-3xl text-[13px] leading-relaxed text-slate-300">{regime.explanation}</p>
        <p className="mt-2 font-mono text-[11px] text-slate-500">
          breadth {regime.breadthUpPct ?? "—"}% up · median |24h| {regime.medianAbsChangePct ?? "—"}% ·{" "}
          {regime.marketsCounted} markets · deterministic, no LLM
        </p>
      </div>
    </Card>
  );
}

function ScanHighlights() {
  const { summary, scanning, pausedStale } = useScan();
  const { connection, lastSuccessAt, updatedAt, markets } = useMarkets();
  const mainSymbols = useMemo(
    () => new Set(markets.filter((m) => !m.symbol.includes(":")).map((m) => m.symbol.toUpperCase())),
    [markets],
  );
  const results = summary?.results ?? [];
  const longs = results.filter((r) => r.signal.direction === "LONG").slice(0, 5);
  const shorts = results.filter((r) => r.signal.direction === "SHORT").slice(0, 5);
  const bounces = results.filter((r) => isListableBounce(r.signal)).slice(0, 5);
  const breakouts = results
    .filter((r) => r.setupType === "BREAKOUT" || r.setupType === "BREAKDOWN")
    .slice(0, 5);
  const breadth = summary?.breadth;

  return (
    <div className="mt-5">
      <div className="mb-3 flex items-end justify-between">
        <h2 className="text-sm font-bold tracking-widest text-slate-300 uppercase">
          High-Confluence Setups
        </h2>
        <Link to="/scanner" className="text-xs font-semibold text-cyan-300 hover:text-cyan-200">
          Full scanner →
        </Link>
      </div>
      {pausedStale ? (
        <p className="rounded-xl border border-amber-400/25 bg-amber-400/[0.06] px-4 py-3 text-xs font-bold text-amber-200">
          DATA STALE — highlights paused until the feed recovers.
        </p>
      ) : (
        <>
          {breadth && breadth.counted > 0 && (
            <div className="mb-3 flex flex-wrap items-center gap-3 rounded-xl border border-slate-800 bg-slate-900/60 px-4 py-2.5 text-xs">
              <span className="font-bold tracking-widest text-slate-500 uppercase">Market Breadth</span>
              <span className="font-mono text-emerald-300">Bullish {breadth.bullishPct}%</span>
              <span className="font-mono text-slate-400">Neutral {breadth.neutralPct}%</span>
              <span className="font-mono text-rose-300">Bearish {breadth.bearishPct}%</span>
              <span className="ml-auto text-slate-600">from {breadth.counted} scored markets</span>
            </div>
          )}
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <HighlightCard title="High-Confluence Longs" to="/scanner" rows={longs} empty={scanning ? "Scoring…" : "None right now"} mainSymbols={mainSymbols} />
            <HighlightCard title="High-Confluence Shorts" to="/scanner" rows={shorts} empty={scanning ? "Scoring…" : "None right now"} mainSymbols={mainSymbols} />
            <HighlightCard title="Bounce Setups" to="/bounce" rows={bounces} empty={scanning ? "Scoring…" : "None detected"} mainSymbols={mainSymbols} />
            <HighlightCard title="Breakout Setups" to="/scanner" rows={breakouts} empty={scanning ? "Scoring…" : "None detected"} mainSymbols={mainSymbols} />
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-3 rounded-xl border border-slate-800 bg-slate-900/60 px-4 py-2.5 text-xs text-slate-400">
            <span className="font-bold tracking-widest text-slate-500 uppercase">Market Data Status</span>
            <ConnectionBadge showLabel={false} />
            <span className="font-mono">{connection}</span>
            <span>·</span>
            <FreshnessLabel updatedAt={lastSuccessAt || updatedAt} />
            <span>·</span>
            <span>{summary ? `last scan ${timeAgo(summary.completedAt)}` : "no scan yet"}</span>
          </div>
        </>
      )}
    </div>
  );
}

function HighlightCard({
  title,
  to,
  rows,
  empty,
  mainSymbols,
}: {
  title: string;
  to: string;
  rows: { symbol: string; signal: { direction: string; signalStrength: number } }[];
  empty: string;
  mainSymbols: Set<string>;
}) {
  return (
    <Card className="p-4">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-[11px] font-bold tracking-widest text-slate-400 uppercase">{title}</p>
        <Link to={to} className="text-[11px] font-semibold text-cyan-300 hover:underline">→</Link>
      </div>
      {rows.length === 0 ? (
        <p className="py-3 text-center text-xs text-slate-600">{empty}</p>
      ) : (
        <ul className="space-y-1.5">
          {rows.map((r) => (
            <li key={r.symbol}>
              <Link to={`/coin/${r.symbol}`} className="flex min-w-0 items-center justify-between gap-2 rounded-lg border border-slate-800/60 px-2.5 py-1.5 hover:border-slate-700">
                <span className="min-w-0 truncate text-xs font-bold text-white">{r.symbol}</span>
                <span className="flex shrink-0 items-center gap-1.5">
                  <CategoryChip symbol={r.symbol} mainSymbols={mainSymbols} />
                  <span className={cn("font-mono text-xs", r.signal.direction === "LONG" ? "text-emerald-300" : "text-rose-300")}>
                    {r.signal.signalStrength}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function RecentSignalsList() {
  const { markets } = useMarkets();
  const { user } = useAuth();
  const mainSymbols = useMemo(
    () => new Set(markets.filter((m) => !m.symbol.includes(":")).map((m) => m.symbol.toUpperCase())),
    [markets],
  );
  // Signed in: authoritative cloud history (includes signals generated
  // while this browser was closed). Signed out: this-device journal only,
  // explicitly labeled — the two sources are never silently mixed.
  const server = useServerHistory("server", "ALL", !!user);
  const source: "server" | "local" = user ? "server" : "local";
  const entries = useMemo(() => {
    if (source === "server") return server.entries.slice(0, 8);
    return loadJournal()
      .sort((a, b) => b.lastSeen - a.lastSeen)
      .slice(0, 8);
  }, [source, server.entries]);
  if (source === "server" && server.loading) {
    return <p className="px-5 py-8 text-center text-sm text-slate-500">Loading cloud signals…</p>;
  }
  if (source === "server" && server.error) {
    return (
      <div className="px-5 py-8 text-center">
        <p className="text-sm font-semibold text-rose-300">Unable to load cloud signals.</p>
        <p className="mx-auto mt-1 max-w-md text-xs text-slate-500">{server.error}</p>
        <button onClick={server.refresh} className="mt-3 min-h-[44px] rounded-xl border border-slate-700 px-5 text-xs font-bold text-slate-200 hover:bg-slate-800">
          Retry
        </button>
      </div>
    );
  }
  if (entries.length === 0) {
    return (
      <p className="px-5 py-8 text-center text-sm text-slate-500">
        {source === "server"
          ? "No cloud signals in the last scan window yet — the 24/7 cron records here even while this browser is closed."
          : "No device signals yet — run a scan, or sign in to view cloud signal history."}
      </p>
    );
  }
  return (
    <>
      <p className="px-5 pt-3 text-[11px] font-bold tracking-widest text-slate-500 uppercase">
        {source === "server" ? "Latest Server Signals · Cloud" : "Device Signals · this browser only"}
      </p>
      <ul className="divide-y divide-slate-800/60">
        {entries.map((e) => (
          <li key={e.id} className="flex min-w-0 flex-wrap items-center gap-2 px-5 py-2 text-xs">
            <CategoryChip symbol={e.symbol} mainSymbols={mainSymbols} />
            <Link to={`/coin/${e.symbol}`} className="font-bold break-words text-white hover:text-cyan-300">{e.symbol}</Link>
            <span className={cn("font-bold", e.direction === "LONG" ? "text-emerald-300" : "text-rose-300")}>{e.direction}</span>
            <span className="font-mono text-slate-400">{e.strength}</span>
            <span className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[10px] text-slate-400">{e.status}</span>
            <span className="ml-auto text-slate-600">{timeAgo(e.lastSeen)}</span>
          </li>
        ))}
      </ul>
    </>
  );
}

/** Compact paper-performance teaser: live engine values, never invented. */
function PaperTeaser() {
  const engine = useMemo(() => getSharedPaperEngine(), []);
  const [snap, setSnap] = useState<PaperSnapshot>(() => engine.getSnapshot());
  const { markets } = useMarkets();
  useEffect(() => engine.subscribe(setSnap), [engine]);
  const marks = useMemo(() => {
    const m = new Map<string, number>();
    for (const mk of markets) if (mk.markPrice !== null) m.set(mk.symbol, mk.markPrice);
    return m;
  }, [markets]);
  const open = snap.positions.filter((p) => p.closedAt === null);
  const unreal = open.reduce((a, p) => a + unrealizedFor(p, marks.get(p.symbol) ?? NaN), 0);
  const equity = snap.balance + unreal;
  const winRate = snap.closedCount > 0 ? (snap.wins / snap.closedCount) * 100 : 0;
  return (
    <Card>
      <CardHeader
        title="Paper Performance"
        subtitle="Simulated account · live marks"
        right={
          <Link to="/paper" className="text-xs font-semibold text-cyan-300 hover:underline">
            Open →
          </Link>
        }
      />
      <div className="grid grid-cols-2 gap-2.5 p-4">
        {[
          ["Equity", `$${equity.toFixed(2)}`],
          ["Cash", `$${snap.balance.toFixed(2)}`],
          ["Realized P&L", `${snap.realizedPnl >= 0 ? "+" : ""}$${snap.realizedPnl.toFixed(2)}`],
          ["Win Rate", `${winRate.toFixed(1)}% (${snap.wins}/${snap.closedCount})`],
          ["Open Positions", String(open.length)],
          ["Unrealized P&L", `${unreal >= 0 ? "+" : ""}$${unreal.toFixed(2)}`],
        ].map(([k, v]) => (
          <div key={k} className="rounded-xl border border-slate-800 bg-slate-950/60 p-3">
            <p className="text-[10px] font-bold tracking-widest text-slate-500 uppercase">{k}</p>
            <p className="mt-1 font-mono text-sm font-bold text-slate-100">{v}</p>
          </div>
        ))}
      </div>
    </Card>
  );
}

/** Compact Telegram status: connection + enabled categories, read-only. */
function TelegramTeaser() {
  const { state } = useTelegramConnection();
  const cats = loadAlertSettings().categories;
  const enabled = (["crypto", "stocks", "commodities"] as const).filter((c) => cats[c]);
  const connected = state.phase === "ready" && state.status.connected;
  return (
    <Card>
      <CardHeader
        title="Telegram"
        subtitle="Push delivery status"
        right={
          <Link to="/settings" className="text-xs font-semibold text-cyan-300 hover:underline">
            Setup →
          </Link>
        }
      />
      <div className="space-y-2 p-4 text-xs">
        <p className="flex items-center gap-2">
          <span aria-hidden="true">{state.phase === "loading" ? "🟡" : connected ? "🟢" : "⚪"}</span>
          <span className="font-bold text-slate-200">
            {state.phase === "loading"
              ? "Checking…"
              : state.phase === "signed-out"
                ? "Sign in to connect Telegram"
                : connected
                  ? `Connected${state.status.username ? ` @${state.status.username}` : ""}`
                  : state.phase === "error"
                    ? "Status unavailable"
                    : "Not connected"}
          </span>
        </p>
        <p className="text-slate-400">
          Categories: {enabled.length > 0 ? enabled.join(" · ") : "none enabled"}
        </p>
        <p className="text-slate-600">Pairing, test delivery and filters live in Settings → Telegram.</p>
      </div>
    </Card>
  );
}

export default function Dashboard() {
  const { markets, status, error, updatedAt, refresh } = useMarkets();
  const bySymbol = new Map(markets.map((m) => [m.symbol, m]));
  const btc = bySymbol.get("BTC");
  const eth = bySymbol.get("ETH");

  const majors = MAJORS.map((s) => bySymbol.get(s)).filter(
    (m): m is NonNullable<typeof m> => Boolean(m),
  );

  const loading = status === "loading" && markets.length === 0;
  const failed = status === "error" && markets.length === 0;

  const btcChg = formatChangePct(btc?.dayChangePct ?? null);
  const ethChg = formatChangePct(eth?.dayChangePct ?? null);

  return (
    <div>
      <PageHeader
        title="Dashboard"
        description="Live Hyperliquid overview with deterministic signal intelligence. Ranks are confluence, never advice."
        right={
          <div className="flex items-center gap-2">
            <FreshnessLabel updatedAt={updatedAt} />
            <ConnectionBadge />
          </div>
        }
      />

      {/* MARKET REGIME — live */}
      <Card>
        <CardHeader
          title="Market Regime"
          subtitle="BTC · ETH · majors — live Hyperliquid mark prices"
          right={<LiveBadge status={status} />}
        />
        {loading ? (
          <p className="px-5 py-10 text-center text-sm text-slate-400">
            Loading live Hyperliquid markets…
          </p>
        ) : failed ? (
          <div className="px-5 py-8 text-center">
            <p className="text-sm font-semibold text-rose-300">
              {error ?? "Unable to retrieve Hyperliquid market data. Retrying…"}
            </p>
            <button
              onClick={refresh}
              className="mt-3 rounded-xl border border-slate-700 px-4 py-2 text-xs font-bold text-slate-200 hover:bg-slate-800"
            >
              Retry
            </button>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 p-4 lg:grid-cols-4">
              <RegimeCard
                title="BTC"
                value={formatPriceUsd(btc?.markPrice ?? null, "BTC")}
                sub={`${btcChg.text} · 24h · Vol ${formatVolumeNotional(btc?.dayVolumeNotional ?? null)}`}
                tone={btcChg.positive === null ? null : btcChg.positive ? "up" : "down"}
              />
              <RegimeCard
                title="ETH"
                value={formatPriceUsd(eth?.markPrice ?? null, "ETH")}
                sub={`${ethChg.text} · 24h · Vol ${formatVolumeNotional(eth?.dayVolumeNotional ?? null)}`}
                tone={ethChg.positive === null ? null : ethChg.positive ? "up" : "down"}
              />
              <RegimeCard
                title="BTC Funding"
                value={formatFundingRate(btc?.fundingRate ?? null)}
                sub={`ETH ${formatFundingRate(eth?.fundingRate ?? null)} · hourly rate`}
              />
              <RegimeCard
                title="Universe"
                value={markets.length > 0 ? String(markets.length) : "—"}
                sub="Hyperliquid perp markets tracked"
              />
            </div>
            {majors.length > 0 && (
              <div className="grid grid-cols-2 gap-2 border-t border-slate-800/70 px-4 py-3 sm:grid-cols-4">
                {majors.slice(0, 8).map((m) => {
                  const chg = formatChangePct(m.dayChangePct);
                  return (
                    <Link
                      key={m.symbol}
                      to={`/coin/${m.symbol}`}
                      className="rounded-lg border border-slate-800/70 bg-slate-950/50 px-3 py-2 hover:border-slate-700"
                    >
                      <span className="flex items-center justify-between text-xs font-bold text-slate-200">
                        {m.symbol}
                        <span
                          className={cn(
                            "font-mono",
                            chg.positive === true && "text-emerald-300",
                            chg.positive === false && "text-rose-300",
                            chg.positive === null && "text-slate-400",
                          )}
                        >
                          {chg.text}
                        </span>
                      </span>
                      <span className="mt-0.5 block font-mono text-[13px] text-slate-300">
                        {formatPriceUsd(m.markPrice, m.symbol)}
                      </span>
                    </Link>
                  );
                })}
              </div>
            )}
          </>
        )}
        <div className="flex flex-wrap items-center gap-2 border-t border-slate-800/80 px-5 py-3 text-xs text-slate-500">
          <Bitcoin className="h-3.5 w-3.5" />
          <span>Source: Hyperliquid public API (metaAndAssetCtxs + allMids WS).</span>
          <span className="ml-auto">
            <FreshnessLabel updatedAt={updatedAt} />
          </span>
        </div>
      </Card>

      {/* AI MARKET REGIME — deterministic summary of supplied market data */}
      <AiMarketRegime markets={markets} />

      {/* HIGH-CONFLUENCE SETUPS — live scan, rank is confluence not advice */}
      <ScanHighlights />

      {/* 24/7 CRON HEALTH — reads the same scanner_state the bot reads */}
      <ScannerHealthPanel />

      {/* PAPER + TELEGRAM teasers — live values only, never invented */}
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <PaperTeaser />
        <TelegramTeaser />
      </div>

      {/* Market snapshot + signals note */}
      <div className="mt-5 grid gap-4 lg:grid-cols-5">
        <Card className="lg:col-span-2">
          <CardHeader title="Market Snapshot" subtitle="Top volume movers (live)" />
          {loading ? (
            <p className="px-5 py-8 text-center text-xs text-slate-500">Loading…</p>
          ) : (
            <div className="space-y-2 p-4">
              {[...markets]
                .filter((m) => m.dayVolumeNotional !== null)
                .sort((a, b) => (b.dayVolumeNotional ?? 0) - (a.dayVolumeNotional ?? 0))
                .slice(0, 5)
                .map((m) => (
                  <Link
                    key={m.symbol}
                    to={`/coin/${m.symbol}`}
                    className="flex items-center justify-between rounded-lg border border-slate-800/70 px-3 py-2 hover:border-slate-700"
                  >
                    <span className="text-xs font-bold text-white">{m.symbol}</span>
                    <span className="font-mono text-xs text-slate-300">
                      {formatPriceUsd(m.markPrice, m.symbol)}
                    </span>
                    <span className="font-mono text-[11px] text-slate-500">
                      OI {formatOiCoins(m.openInterestCoins)}
                    </span>
                  </Link>
                ))}
            </div>
          )}
        </Card>

        <Card className="lg:col-span-3">
          <CardHeader
            title="Recent Signals"
            subtitle="Cloud history when signed in · device journal otherwise"
            right={
              <Link to="/history" className="text-xs font-semibold text-cyan-300 hover:underline">
                Full history →
              </Link>
            }
          />
          <ServerSignalCounts />
          <RecentSignalsList />
        </Card>
      </div>

      {error && markets.length > 0 && (
        <p className="mt-3 rounded-xl border border-amber-400/25 bg-amber-400/[0.06] px-4 py-2.5 text-xs text-amber-200">
          {error} Showing last good snapshot.
        </p>
      )}
    </div>
  );
}
