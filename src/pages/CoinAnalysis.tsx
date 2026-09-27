import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { Card, CardHeader, DemoBadge, DirectionBadge, PageHeader, Stat } from "../components/ui";
import { AiAnalysisCard } from "../components/AiAnalysisCard";
import { NewsList } from "../components/NewsList";
import { buildAiInput } from "../ai/input";
import { useAiAnalysis } from "../ai/useAiAnalysis";
import { useNews } from "../news/useNews";
import { CandleChart } from "../components/CandleChart";
import { FreshnessLabel, LiveBadge } from "../components/LiveBadge";
import { ConnectionBadge } from "../components/ConnectionBadge";
import { useMarkets } from "../market/store";
import { useMtfCandles, useSignal } from "../analysis/hooks";
import { SUPPORTED_TIMEFRAMES } from "../market/hyperliquid/timeframes";
import type { Timeframe } from "../market/hyperliquid/types";
import { lastEma } from "../indicators/ema";
import { lastRsi } from "../indicators/rsi";
import { lastMacd } from "../indicators/macd";
import { lastAtr } from "../indicators/atr";
import { volumeStats } from "../indicators/volume";
import { formatFundingRate } from "../market/hyperliquid/funding";
import { formatOpenInterestNotional } from "../market/hyperliquid/openInterest";
import {
  formatChangePct,
  formatPriceUsd,
  formatVolumeNotional,
} from "../lib/format";
import { cn } from "../lib/cn";
import { classifySetupType } from "../signals/setupType";
import { assessQuality } from "../signals/quality";
import { backfillAiSummary, loadJournal } from "../signals/journal";
import { summarizeRegime } from "../ai/regime";
import { subscribeAlerts, type SignalEvent } from "../alerts";
import { getSharedPaperEngine } from "../paper";
import { useScan } from "../scanner";
import type { Signal } from "../analysis/signal";

function fmt(n: number | null, digits = 4): string {
  if (n === null || !Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** Lifecycle state of the latest journaled setup for this coin+direction. */
function CoinSignalState({ symbol, direction }: { symbol: string; direction: string }) {
  if (direction !== "LONG" && direction !== "SHORT") return null;
  const latest = loadJournal()
    .filter((e) => e.symbol === symbol && e.direction === direction)
    .sort((a, b) => b.lastSeen - a.lastSeen)[0];
  if (!latest) return <span className="rounded bg-slate-800 px-2 py-0.5 font-mono text-[11px] text-slate-400">UNTRACKED</span>;
  return (
    <span className="rounded bg-cyan-400/10 px-2 py-0.5 font-mono text-[11px] font-bold text-cyan-300" title={`Setup ${latest.setupType} · first seen ${new Date(latest.firstSeen).toLocaleString()}`}>
      {latest.status}
    </span>
  );
}

/** Component point bars: Trend/25 Momentum/20 Volume/15 Structure/20 MTF/20. */
function SignalComponents({ signal }: { signal: Signal }) {
  const setupType = classifySetupType(signal);
  const quality = assessQuality(signal);
  const bars: [string, number, number][] = [
    ["Trend", signal.components.trend, 25],
    ["Momentum", signal.components.momentum, 20],
    ["Volume", signal.components.volume, 15],
    ["Structure", signal.components.structure, 20],
    ["MTF", signal.components.mtf, 20],
  ];
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-[11px] font-bold tracking-widest text-slate-500 uppercase">Setup: {setupType}</p>
        <span className="rounded bg-slate-800 px-2 py-0.5 text-[11px] font-bold text-slate-300">{quality}</span>
      </div>
      <div className="mt-2.5 space-y-1.5">
        {bars.map(([label, value, max]) => (
          <div key={label} className="flex items-center gap-2 text-[11px]">
            <span className="w-20 shrink-0 font-bold tracking-wider text-slate-500 uppercase">{label}</span>
            <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-800">
              <span className="block h-full rounded-full bg-cyan-400" style={{ width: `${Math.min(100, (value / max) * 100)}%` }} />
            </span>
            <span className="w-14 shrink-0 text-right font-mono text-slate-300">{value}/{max}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Regime + breadth context chips — context only, never overrides. */
function MarketContextStrip() {
  const { markets } = useMarkets();
  const { summary } = useScan();
  const regime = summarizeRegime(markets);
  const breadth = summary?.breadth;
  return (
    <div className="flex flex-wrap gap-2 text-[11px]">
      <span className="rounded-full border border-slate-800 bg-slate-950 px-3 py-1 text-slate-300">
        Market regime: <strong>{regime.regime}</strong> <span className="text-slate-600">(context only)</span>
      </span>
      {breadth && breadth.counted > 0 && (
        <span className="rounded-full border border-slate-800 bg-slate-950 px-3 py-1 font-mono text-slate-300">
          Breadth {breadth.bullishPct}% / {breadth.neutralPct}% / {breadth.bearishPct}%
        </span>
      )}
    </div>
  );
}

/** Past journaled outcomes for this coin (observed touches, not profits). */
function CoinOutcomes({ symbol }: { symbol: string }) {
  const entries = loadJournal()
    .filter((e) => e.symbol === symbol)
    .sort((a, b) => b.lastSeen - a.lastSeen)
    .slice(0, 5);
  if (entries.length === 0) return null;
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4">
      <p className="text-[11px] font-bold tracking-widest text-slate-500 uppercase">Historical outcomes · {symbol}</p>
      <ul className="mt-2 space-y-1.5 text-xs">
        {entries.map((e) => (
          <li key={e.id} className="flex flex-wrap items-center gap-2 text-slate-300">
            <span className={cn("font-bold", e.direction === "LONG" ? "text-emerald-300" : "text-rose-300")}>{e.direction}</span>
            <span className="font-mono">{e.strength}</span>
            <span className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[10px] text-slate-400">{e.status}</span>
            {e.outcome && (
              <span className="font-mono text-[11px] text-slate-500">
                T1{e.outcome.tp1Reached ? "✓" : "·"} T2{e.outcome.tp2Reached ? "✓" : "·"} T3{e.outcome.tp3Reached ? "✓" : "·"} X{e.outcome.invalidationReached ? "✓" : "·"} · MFE {e.outcome.mfeR}R
              </span>
            )}
            <span className="ml-auto text-slate-600">{new Date(e.firstSeen).toLocaleDateString()}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Signal timeline: only events that actually occurred for this coin. */
function SignalTimeline({ symbol }: { symbol: string }) {
  const [events, setEvents] = useState<SignalEvent[]>([]);
  useEffect(() => subscribeAlerts(setEvents), []);
  const rows = events
    .filter((e) => e.symbol === symbol)
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, 12);
  if (rows.length === 0) return null;
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4">
      <p className="text-[11px] font-bold tracking-widest text-slate-500 uppercase">Signal Timeline · {symbol}</p>
      <ul className="mt-2 space-y-1.5">
        {rows.map((e) => (
          <li key={e.id} className="flex items-center gap-2 text-xs">
            <span className={cn("font-bold", e.direction === "LONG" ? "text-emerald-300" : "text-rose-300")}>
              {e.direction}
            </span>
            <span className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[10px] text-slate-300">
              {e.type.replace(/_/g, " ")}
            </span>
            {e.detail && <span className="font-mono text-[11px] text-cyan-300">{e.detail}</span>}
            <span className="font-mono text-slate-500">{e.currentStrength}</span>
            <span className="ml-auto text-slate-600">{new Date(e.timestamp).toLocaleString()}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Signal → simulated position with explicit confirmation. Never an order. */
function TakePaperTrade({ signal, coin, mark }: { signal: Signal; coin: string; mark: number | null }) {
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const tradeable =
    (signal.direction === "LONG" || signal.direction === "SHORT") &&
    signal.invalidation !== null &&
    signal.tp1 !== null &&
    mark !== null;
  if (!tradeable) return null;

  const engine = getSharedPaperEngine();
  const cfg = engine.getSnapshot().config;
  const entry = mark as number;
  const stopDist =
    signal.direction === "LONG" ? entry - (signal.invalidation as number) : (signal.invalidation as number) - entry;
  const risk = engine.getSnapshot().balance * cfg.riskPerTrade;
  const size = stopDist > 0 ? risk / stopDist : 0;

  const confirm = () => {
    const marks = new Map([[coin, entry]]);
    const pos = engine.open(
      {
        symbol: coin,
        timeframe: signal.timeframe,
        setupType: classifySetupType(signal),
        direction: signal.direction as "LONG" | "SHORT",
        entry,
        invalidation: signal.invalidation as number,
        tp1: signal.tp1 as number,
        tp2: signal.tp2 as number,
        tp3: signal.tp3 as number,
        strength: signal.signalStrength,
      },
      marks,
    );
    setDone(pos ? `Simulated ${pos.direction} opened: ${size.toFixed(4)} ${coin} @ ${fmt(entry)}.` : "Already have an open simulated position on this coin.");
    setOpen(false);
  };

  return (
    <span>
      <button onClick={() => { setDone(null); setOpen(true); }} className="rounded-xl bg-cyan-500 px-3 py-1.5 text-xs font-bold text-slate-950 hover:bg-cyan-400">
        TAKE PAPER TRADE
      </button>
      {done && <span className="ml-2 text-[11px] text-slate-400">{done} <Link to="/paper" className="font-bold text-cyan-300 hover:underline">View →</Link></span>}
      {open && (
        <span className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={() => setOpen(false)}>
          <span className="w-full max-w-md rounded-2xl border border-slate-700 bg-slate-900 p-5" onClick={(e) => e.stopPropagation()}>
            <p className="text-sm font-extrabold text-white">Confirm simulated trade <span className="text-amber-300">(NO REAL ORDER)</span></p>
            <div className="mt-3 space-y-1.5 font-mono text-[13px]">
              {[
                ["Direction", signal.direction],
                ["Entry (live mark)", fmt(entry)],
                ["Invalidation", fmt(signal.invalidation)],
                ["TP1 / TP2 / TP3", `${fmt(signal.tp1)} / ${fmt(signal.tp2)} / ${fmt(signal.tp3)}`],
                ["Risk", `$${risk.toFixed(2)} (${(cfg.riskPerTrade * 100).toFixed(2)}% of paper equity)`],
                ["Position size", `${size.toFixed(4)} ${coin} ≈ $${(size * entry).toFixed(2)} notional`],
              ].map(([k, v]) => (
                <span key={k as string} className="flex items-center justify-between border-b border-dashed border-slate-800 pb-1.5">
                  <span className="font-sans text-slate-500">{k}</span>
                  <span className="font-bold text-slate-100">{v}</span>
                </span>
              ))}
            </div>
            <span className="mt-4 flex gap-2">
              <button onClick={confirm} className="flex-1 rounded-xl bg-cyan-500 px-4 py-2.5 text-sm font-bold text-slate-950 hover:bg-cyan-400">
                Confirm simulation
              </button>
              <button onClick={() => setOpen(false)} className="rounded-xl border border-slate-700 px-4 py-2.5 text-sm font-bold text-slate-300">
                Cancel
              </button>
            </span>
          </span>
        </span>
      )}
    </span>
  );
}

export default function CoinAnalysis() {
  const { symbol = "OP" } = useParams();
  const coin = (symbol ?? "OP").toUpperCase();
  const [tf, setTf] = useState<Timeframe>("15m");
  const location = useLocation();
  // Alert context banner: validated shape only; refresh-safe (absent on reload).
  const alertCtx =
    location.state !== null &&
    typeof location.state === "object" &&
    (location.state as { fromAlert?: unknown }).fromAlert !== null &&
    typeof (location.state as { fromAlert?: unknown }).fromAlert === "object"
      ? ((location.state as { fromAlert: Record<string, unknown> }).fromAlert as {
          id?: unknown;
          type?: unknown;
          direction?: unknown;
          strength?: unknown;
          timestamp?: unknown;
        })
      : null;
  const alertBanner =
    alertCtx !== null &&
    (alertCtx.direction === "LONG" || alertCtx.direction === "SHORT") &&
    typeof alertCtx.strength === "number" &&
    typeof alertCtx.timestamp === "number"
      ? {
          type: typeof alertCtx.type === "string" ? alertCtx.type.replace(/_/g, " ") : "signal",
          direction: alertCtx.direction as "LONG" | "SHORT",
          strength: alertCtx.strength,
          timestamp: alertCtx.timestamp,
        }
      : null;
  const [bannerDismissed, setBannerDismissed] = useState(false);

  const { markets, status: mktStatus, updatedAt: mktUpdated, stale: mktStale } = useMarkets();
  const market = useMemo(
    () => markets.find((m) => m.symbol === coin),
    [markets, coin],
  );
  const { data: mtf, loading: candlesLoading, error: candlesError } = useMtfCandles(coin);
  const signal = useSignal(coin, mtf, "15m");

  const chartCandles = mtf[tf] ?? [];
  const chg = formatChangePct(market?.dayChangePct ?? null);

  // Real indicator snapshot for the selected chart timeframe.
  const ind = useMemo(() => {
    if (chartCandles.length === 0) return null;
    const closes = chartCandles.map((c) => c.close);
    const volumes = chartCandles.map((c) => c.volume);
    const macd = lastMacd(closes);
    const vol = volumeStats(volumes, 20);
    return {
      ema20: lastEma(closes, 20),
      ema50: lastEma(closes, 50),
      ema200: lastEma(closes, 200),
      rsi: lastRsi(closes, 14),
      macdLine: macd.line,
      macdSignal: macd.signal,
      macdHist: macd.histogram,
      atr: lastAtr(chartCandles, 14),
      relVol: vol?.relative ?? null,
      spike: vol?.spike ?? false,
      count: chartCandles.length,
    };
  }, [chartCandles]);

  const watchlist = useMemo(() => {
    const preferred = ["BTC", "ETH", "SOL", "OP", "ARB", "AVAX", "LINK", "DOGE"];
    const available = new Set(markets.map((m) => m.symbol));
    const list = preferred.filter((s) => available.has(s));
    if (!available.has(coin)) return [coin, ...list].slice(0, 8);
    return [coin, ...list.filter((s) => s !== coin)].slice(0, 8);
  }, [markets, coin]);

  const showStaleSignal = mktStale && signal !== null;
  const insufficient =
    !candlesLoading && (chartCandles.length > 0 && chartCandles.length < 210);

  // AI input: engine numbers + market snapshot + verified news, copied only.
  const { items: newsItems, loading: newsLoading } = useNews(coin);
  const aiInput = useMemo(() => {
    if (!signal || mktStale) return null;
    try {
      return buildAiInput({ symbol: coin, market, candlesByTf: mtf, signal, news: newsItems });
    } catch {
      return null;
    }
  }, [signal, mktStale, coin, market, mtf, newsItems]);
  const ai = useAiAnalysis(aiInput, "15m", aiInput !== null);

  // Lazy journal backfill: the coin explanation enriches logged signals.
  useEffect(() => {
    if (
      ai.state === "ok" &&
      ai.analysis &&
      signal &&
      (signal.direction === "LONG" || signal.direction === "SHORT")
    ) {
      backfillAiSummary(coin, signal.direction, ai.analysis.summary);
    }
  }, [ai.state, ai.analysis, signal, coin]);

  return (
    <div>
      <PageHeader
        title={`Coin Analysis · ${coin}`}
        description="Deterministic technical analysis on live Hyperliquid candles, explained block by block. The engine decides; the AI only explains."
        right={
          <div className="flex items-center gap-2">
            <FreshnessLabel updatedAt={mktUpdated} />
            <ConnectionBadge />
          </div>
        }
      />

      {alertBanner && !bannerDismissed && (
        <div className="mb-4 flex items-center gap-3 rounded-2xl border border-cyan-400/30 bg-cyan-400/[0.07] px-5 py-3 text-[13px] text-slate-200">
          <span>
            Opened from alert: <strong>{alertBanner.type}</strong> · {coin} {alertBanner.direction} ·
            strength {alertBanner.strength} · {new Date(alertBanner.timestamp).toLocaleString()} — showing
            current live analysis, which may have evolved since the alert.
          </span>
          <button
            onClick={() => setBannerDismissed(true)}
            aria-label="Dismiss alert context"
            className="ml-auto rounded-lg border border-slate-700 px-2 py-1 text-[11px] font-bold text-slate-300 hover:bg-slate-800"
          >
            Dismiss
          </button>
        </div>
      )}

      <div className="mb-4 flex flex-wrap gap-2">
        {watchlist.map((c) => (
          <Link
            key={c}
            to={`/coin/${c}`}
            className={cn(
              "rounded-full border px-3 py-1.5 text-xs font-bold",
              c === coin
                ? "border-cyan-400/50 bg-cyan-400/10 text-cyan-200"
                : "border-slate-800 bg-slate-900 text-slate-400 hover:border-slate-700 hover:text-slate-200",
            )}
          >
            {c}
          </Link>
        ))}
      </div>

      {!market && mktStatus !== "loading" ? (
        <Card className="mb-4">
          <div className="px-5 py-8 text-center">
            <p className="text-sm font-semibold text-amber-300">
              {coin} is not listed on Hyperliquid perps.
            </p>
            <p className="mt-1 text-xs text-slate-500">
              Missing-market state handled without invented prices. Try BTC, ETH, SOL or OP.
            </p>
          </div>
        </Card>
      ) : null}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat
          label="Price"
          value={formatPriceUsd(market?.markPrice ?? null, coin)}
          sub={market ? "mark · live" : "—"}
        />
        <Stat
          label="24h Change"
          value={chg.text}
          sub={`prev ${formatPriceUsd(market?.prevDayPrice ?? null, coin)}`}
        />
        <Stat label="Volume" value={formatVolumeNotional(market?.dayVolumeNotional ?? null)} sub="24h notional" />
        <Stat label="Funding" value={formatFundingRate(market?.fundingRate ?? null)} sub="hourly rate" />
        <Stat
          label="Open Interest"
          value={formatOpenInterestNotional(market?.openInterestNotional ?? null)}
          sub="coins × mark"
        />
      </div>

      <Card className="mt-4">
        <CardHeader
          title={`Price Chart · ${coin} / USD`}
          subtitle={`${chartCandles.length} ${tf} candles · computed locally`}
          right={
            <div className="flex gap-1 rounded-lg border border-slate-800 bg-slate-950 p-1">
              {SUPPORTED_TIMEFRAMES.map((t) => (
                <button
                  key={t}
                  onClick={() => setTf(t)}
                  className={cn(
                    "rounded-md px-2.5 py-1 text-[11px] font-bold",
                    tf === t ? "bg-slate-800 text-white" : "text-slate-500 hover:text-slate-300",
                  )}
                >
                  {t}
                </button>
              ))}
            </div>
          }
        />
        <div className="p-2">
          {candlesLoading ? (
            <p className="flex h-[260px] items-center justify-center text-sm text-slate-400">
              Loading {coin} candles (4h / 1h / 15m / 5m)…
            </p>
          ) : candlesError ? (
            <div className="flex h-[260px] flex-col items-center justify-center text-center">
              <p className="max-w-md text-sm font-semibold text-rose-300">{candlesError}</p>
              <p className="mt-1 text-xs text-slate-500">Missing-candle state — no fabricated prices.</p>
            </div>
          ) : (
            <>
              <CandleChart candles={chartCandles} />
              <div className="flex flex-wrap items-center gap-2 px-3 pt-1 pb-2 text-[11px] text-slate-500">
                <LiveBadge status={mktStatus} />
                <FreshnessLabel updatedAt={mktUpdated} />
              </div>
            </>
          )}
        </div>
      </Card>

      {/* Real indicator values for the selected timeframe */}
      <Card className="mt-4">
        <CardHeader title={`Indicators · ${tf}`} subtitle="EMA · RSI · MACD · ATR · Volume — calculated locally from OHLCV" />
        <div className="grid grid-cols-2 gap-2.5 p-5 text-sm sm:grid-cols-3 lg:grid-cols-6">
          {[
            ["EMA 20", ind?.ema20 ?? null, 4],
            ["EMA 50", ind?.ema50 ?? null, 4],
            ["EMA 200", ind?.ema200 ?? null, 4],
            ["RSI 14", ind?.rsi ?? null, 1],
            ["ATR 14", ind?.atr ?? null, 4],
            ["Rel. Vol", ind?.relVol ?? null, 2],
          ].map(([label, v, d]) => (
            <div key={label as string} className="rounded-xl border border-slate-800 bg-slate-950/60 p-3">
              <p className="text-[11px] font-bold tracking-widest text-slate-500 uppercase">{label}</p>
              <p className="mt-1 font-mono text-[15px] font-bold text-slate-100">
                {fmt(v as number | null, d as number)}
                {label === "Rel. Vol" && (v as number | null) !== null ? "×" : ""}
              </p>
            </div>
          ))}
        </div>
        <div className="grid grid-cols-3 gap-2.5 px-5 pb-5 text-sm">
          {[
            ["MACD line", ind?.macdLine ?? null],
            ["MACD signal", ind?.macdSignal ?? null],
            ["MACD hist", ind?.macdHist ?? null],
          ].map(([label, v]) => (
            <div key={label as string} className="rounded-xl border border-slate-800 bg-slate-950/60 p-3">
              <p className="text-[11px] font-bold tracking-widest text-slate-500 uppercase">{label}</p>
              <p
                className={cn(
                  "mt-1 font-mono text-[15px] font-bold",
                  (v as number | null) !== null && (v as number) > 0 && (label as string).includes("hist")
                    ? "text-emerald-300"
                    : (v as number | null) !== null && (v as number) < 0 && (label as string).includes("hist")
                      ? "text-rose-300"
                      : "text-slate-100",
                )}
              >
                {fmt(v as number | null, 4)}
              </p>
            </div>
          ))}
        </div>
        {ind?.spike && (
          <p className="px-5 pb-4 text-xs font-semibold text-amber-300">Volume spike on the latest {tf} bar.</p>
        )}
      </Card>

      {/* Signal readout */}
      <Card className="mt-4">
        <CardHeader
          title="Signal · 15m setup"
          subtitle="Deterministic scoring — Signal Strength 0–100, never a probability"
          right={
            signal && !showStaleSignal ? (
              <DirectionBadge direction={signal.direction} />
            ) : (
              <DemoBadge label={showStaleSignal ? "DATA STALE" : insufficient ? "INSUFFICIENT DATA" : "COMPUTING"} />
            )
          }
        />
        {signal === null || candlesLoading ? (
          <p className="px-5 py-8 text-center text-sm text-slate-400">Computing signal…</p>
        ) : showStaleSignal ? (
          <div className="px-5 py-8 text-center">
            <p className="text-sm font-semibold text-amber-300">DATA STALE</p>
            <p className="mx-auto mt-1 max-w-md text-xs text-slate-500">
              Market data is stale — no fresh signal is created from it. Values below are withheld, not guessed.
            </p>
          </div>
        ) : insufficient ? (
          <div className="px-5 py-8 text-center">
            <p className="text-sm font-semibold text-amber-300">INSUFFICIENT DATA</p>
            <p className="mx-auto mt-1 max-w-md text-xs text-slate-500">
              {chartCandles.length}/210 {tf} candles — EMA200 and full indicators need more history.
            </p>
          </div>
        ) : (
          <div className="space-y-4 p-5">
            <div className="flex flex-wrap items-baseline gap-3">
              <span className="font-mono text-3xl font-extrabold text-white">{signal.signalStrength}</span>
              <span className="text-sm font-bold text-cyan-300">{signal.classification}</span>
              <CoinSignalState symbol={coin} direction={signal.direction} />
              <span className="ml-auto font-mono text-xs text-slate-500">
                LONG {signal.longScore} · SHORT {signal.shortScore}
              </span>
            </div>

            <SignalComponents signal={signal} />
            <MarketContextStrip />

            <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
              {[
                ["Trend", signal.trend],
                ["Momentum", signal.momentum],
                ["Volume", signal.volume],
                ["Structure", signal.marketStructure],
              ].map(([k, v]) => (
                <div key={k as string} className="rounded-xl border border-slate-800 bg-slate-950/60 p-3">
                  <p className="text-[11px] font-bold tracking-widest text-slate-500 uppercase">{k}</p>
                  <p className="mt-1 text-sm font-bold text-slate-100">{v}</p>
                </div>
              ))}
            </div>

            {signal.multiTimeframe && (
              <div className="flex flex-wrap gap-2">
                {signal.multiTimeframe.tfs.map((t) => (
                  <span
                    key={t.timeframe}
                    className="rounded-full border border-slate-800 bg-slate-950 px-3 py-1 font-mono text-[11px] text-slate-300"
                  >
                    {t.timeframe}: {t.flavor}
                  </span>
                ))}
                {signal.multiTimeframe.conflict && (
                  <span className="rounded-full border border-amber-400/30 bg-amber-400/10 px-3 py-1 text-[11px] font-bold text-amber-300">
                    MTF conflict — score halved
                  </span>
                )}
              </div>
            )}

            <div>
              <div className="flex items-center justify-between">
                <p className="text-xs font-bold tracking-widest text-slate-500 uppercase">Trade Plan</p>
                <TakePaperTrade signal={signal} coin={coin} mark={market?.markPrice ?? null} />
              </div>
              <div className="mt-2 grid grid-cols-2 gap-2 font-mono text-[13px] sm:grid-cols-4">
                {[
                  ["Entry", signal.entryLow !== null ? `${fmt(signal.entryLow)} – ${fmt(signal.entryHigh)}` : "—"],
                  ["Invalidation", fmt(signal.invalidation)],
                  ["TP1 / TP2 / TP3", signal.tp1 !== null ? `${fmt(signal.tp1)} / ${fmt(signal.tp2)} / ${fmt(signal.tp3)}` : "—"],
                  ["R:R", signal.riskReward !== null ? `1 : ${signal.riskReward}` : "—"],
                ].map(([k, v]) => (
                  <div key={k as string} className="rounded-xl border border-slate-800 bg-slate-950/60 p-3">
                    <p className="font-sans text-[11px] font-bold tracking-widest text-slate-500 uppercase">{k}</p>
                    <p className="mt-1 font-bold text-slate-100">{v}</p>
                  </div>
                ))}
              </div>
            </div>

            <div className="grid gap-2.5 md:grid-cols-2">
              <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4">
                <p className="text-[11px] font-bold tracking-widest text-emerald-400/80 uppercase">Reasons</p>
                <ul className="mt-1.5 space-y-1 text-xs leading-relaxed text-slate-300">
                  {signal.reasons.length === 0 && <li>—</li>}
                  {signal.reasons.map((r, i) => (
                    <li key={i}>· {r}</li>
                  ))}
                </ul>
              </div>
              <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4">
                <p className="text-[11px] font-bold tracking-widest text-amber-400/80 uppercase">Warnings</p>
                <ul className="mt-1.5 space-y-1 text-xs leading-relaxed text-slate-300">
                  {signal.warnings.length === 0 && <li>—</li>}
                  {signal.warnings.map((w, i) => (
                    <li key={i}>· {w}</li>
                  ))}
                </ul>
              </div>
            </div>
            <CoinOutcomes symbol={coin} />
            <SignalTimeline symbol={coin} />
          </div>
        )}
      </Card>

      <div className="mt-4">
        <AiAnalysisCard
          state={mktStale ? "unavailable" : ai.state === "idle" && aiInput === null && !signal ? "idle" : ai.state}
          analysis={mktStale ? null : ai.analysis}
          provider={ai.provider}
          cached={ai.cached}
          marketDataTimestamp={mktUpdated}
        />
      </div>

      <div className="mt-4">
        <NewsList items={newsItems} loading={newsLoading} />
      </div>

      <Card className="mt-4">
        <CardHeader
          title="Signal History"
          subtitle="Every closed signal for this coin lives on the history page"
          right={
            <Link to="/history" className="text-xs font-semibold text-cyan-300 hover:underline">
              Open history →
            </Link>
          }
        />
        <div className="px-5 py-4 text-xs leading-relaxed text-slate-500">
          Signal logging and backtesting arrive in later phases. The deterministic signal above
          is computed fresh from live candles on every visit — nothing is stored yet.
        </div>
      </Card>
    </div>
  );
}
