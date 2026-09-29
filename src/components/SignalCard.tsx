import { memo } from "react";
import { Link } from "react-router-dom";
import { SignalAiButton } from "./SignalAiButton";
import type { ScannedCoin } from "../scanner/engine";
import type { Market } from "../market/hyperliquid/types";
import type { StrengthClass } from "../analysis/scoring";
import { CATEGORY_LABEL, classifyMarket, type MarketCategory } from "../market/classify";
import { formatChangePct, formatPrice, formatVolumeNotional } from "../lib/format";
import { formatFundingRate } from "../market/hyperliquid/funding";
import { formatOpenInterestNotional } from "../market/hyperliquid/openInterest";
import { cn } from "../lib/cn";

/**
 * Shared responsive signal card (Scanner + Markets pages). One layout, one
 * set of fields, no horizontal scrolling: wrapping flex + 2-col level grid
 * with min-w-0/break-words guards. Data flows in untouched from the scan
 * engine — this component only presents it.
 */

export function strengthBand(s: StrengthClass): "WATCH" | "SETUP" | "STRONG" | "HIGH" | "WAIT" {
  if (s === "HIGH-CONFLUENCE SETUP") return "HIGH";
  if (s === "STRONG SETUP") return "STRONG";
  if (s === "SETUP") return "SETUP";
  if (s === "WATCH") return "WATCH";
  return "WAIT";
}

const DIR_META = {
  LONG: { emoji: "🟢", chip: "border-emerald-400/30 bg-emerald-400/10 text-emerald-300" },
  SHORT: { emoji: "🔴", chip: "border-rose-400/30 bg-rose-400/10 text-rose-300" },
  WAIT: { emoji: "⚪", chip: "border-slate-700 bg-slate-800 text-slate-400" },
} as const;

const BAND_CHIP: Record<string, string> = {
  HIGH: "border-cyan-400/40 bg-cyan-400/10 text-cyan-200",
  STRONG: "border-cyan-400/40 bg-cyan-400/10 text-cyan-200",
  SETUP: "border-slate-600 bg-slate-800 text-slate-200",
  WATCH: "border-slate-700 bg-slate-800/60 text-slate-400",
  WAIT: "border-slate-800 bg-slate-900 text-slate-500",
};

function mtfArrow(a: number | null): string {
  if (a === null || Math.abs(a) <= 0.2) return "→";
  return a > 0 ? "↑" : "↓";
}

function money(v: number | null, symbol: string): string {
  return v === null ? "—" : `$${formatPrice(v, symbol)}`;
}

/**
 * Text category chip (never color-only). `mainSymbols` is the live main-dex
 * set for the crypto-mirror rule; callers that already know the category
 * (Markets page) pass it via `category` — explicit wins over derivation.
 */
export function CategoryChip({
  symbol,
  mainSymbols,
  category,
  className,
}: {
  symbol: string;
  mainSymbols?: Set<string>;
  category?: MarketCategory | "other";
  className?: string;
}) {
  const cat = category ?? classifyMarket(symbol, mainSymbols ?? new Set<string>());
  return (
    <span
      className={cn(
        "inline-flex items-center rounded border border-slate-700 bg-slate-800/70 px-1.5 py-0.5 font-mono text-[10px] font-bold tracking-wider text-slate-300",
        className,
      )}
      title={`Market category: ${CATEGORY_LABEL[cat]}`}
    >
      {CATEGORY_LABEL[cat]}
    </span>
  );
}

export const SignalCard = memo(function SignalCard({
  r, market, watched, onToggleStar, category, mainSymbols,
}: {
  r: ScannedCoin;
  market: Market | null;
  watched: boolean;
  onToggleStar: (symbol: string) => void;
  /** Explicit category (Markets page) — derived from markets when omitted. */
  category?: MarketCategory | "other";
  /** Live main-dex set for derivation when `category` is omitted. */
  mainSymbols?: Set<string>;
}) {
  const s = r.signal;
  const dir = DIR_META[s.direction];
  const chg = formatChangePct(market?.dayChangePct ?? null);
  const coinHref = `/coin/${r.symbol}`;
  const entry =
    s.entryLow !== null && s.entryHigh !== null
      ? `${money(s.entryLow, r.symbol)} – ${money(s.entryHigh, r.symbol)}`
      : s.entryLow !== null
        ? money(s.entryLow, r.symbol)
        : "—";
  const band = strengthBand(s.classification);
  const why = s.reasons.length > 0 ? s.reasons.slice(0, 3).join(" + ") : "—";
  const tfs = s.multiTimeframe?.tfs ?? [];

  return (
    <article
      aria-label={`${r.symbol} ${s.direction} signal, score ${s.signalStrength}`}
      className="flex min-w-0 flex-col rounded-2xl border border-slate-800 bg-slate-900/70 break-words"
    >
      <p className="border-b border-slate-800/50 px-4 pt-2.5 text-[10px] font-extrabold tracking-[0.22em] text-slate-500">
        <CategoryChip symbol={r.symbol} category={category} mainSymbols={mainSymbols} className="border-0 bg-transparent p-0" />
      </p>
      {/* Header: star + coin/direction (whole row navigates except the star). */}
      <div className="flex items-stretch gap-1 border-b border-slate-800/80 px-2 py-2">
        <button
          onClick={() => onToggleStar(r.symbol)}
          aria-pressed={watched}
          aria-label={watched ? `Remove ${r.symbol} from watchlist` : `Add ${r.symbol} to watchlist`}
          title={watched ? "Watchlisted" : "Watchlist"}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-xl hover:bg-slate-800 focus-visible:outline-2 focus-visible:outline-cyan-400"
        >
          <span aria-hidden="true" className={watched ? "text-amber-300" : "text-slate-600"}>
            {watched ? "★" : "☆"}
          </span>
        </button>
        <Link
          to={coinHref}
          className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1 rounded-xl px-2 py-1.5 focus-visible:outline-2 focus-visible:outline-cyan-400"
          aria-label={`${r.symbol}, ${s.direction}, score ${s.signalStrength}. Open analysis.`}
        >
          <span className="text-base font-extrabold tracking-tight break-words text-white">{r.symbol}</span>
          <span className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[10px] font-bold text-slate-400">{r.setupType}</span>
          <span className={cn("ml-auto inline-flex min-h-[28px] items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-bold", dir.chip)}>
            {s.direction} <span aria-hidden="true">{dir.emoji}</span>
          </span>
        </Link>
      </div>

      {/* Body navigates to the coin analysis page. */}
      <Link
        to={coinHref}
        className="flex min-w-0 flex-1 flex-col gap-3 p-4 focus-visible:outline-2 focus-visible:outline-cyan-400"
        aria-label={`${r.symbol} details. Open analysis.`}
        tabIndex={-1}
      >
        {/* Price + score */}
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <p className="min-w-0 font-mono text-xl font-extrabold break-words text-white">
            {market?.markPrice != null ? `$${formatPrice(market.markPrice, r.symbol)}` : "—"}{" "}
            <span className={cn("text-sm font-bold", chg.positive === true && "text-emerald-300", chg.positive === false && "text-rose-300", chg.positive === null && "text-slate-500")}>
              {chg.text}
            </span>
          </p>
          <p className="font-mono text-sm font-bold text-slate-100">
            Score {s.signalStrength}{" "}
            <span className={cn("rounded-md border px-1.5 py-0.5 font-sans text-[10px] font-bold tracking-wider", BAND_CHIP[band])}>
              {band}
            </span>
          </p>
        </div>

        {/* Trade levels */}
        <dl className="grid grid-cols-2 gap-2">
          <Level label="Entry" value={entry} />
          <Level label="Stop loss" value={money(s.invalidation, r.symbol)} />
          <Level label="TP1" value={money(s.tp1, r.symbol)} />
          <Level label="TP2" value={money(s.tp2, r.symbol)} />
          <Level label="TP3" value={money(s.tp3, r.symbol)} />
          <Level label="R:R" value={s.riskReward !== null ? `1 : ${s.riskReward}` : "—"} />
        </dl>

        {/* Multi-timeframe */}
        <div>
          <p className="mb-1 text-[10px] font-bold tracking-widest text-slate-500 uppercase">Multi-timeframe</p>
          {tfs.length === 0 ? (
            <p className="font-mono text-xs text-slate-500">—</p>
          ) : (
            <ul className="flex flex-wrap gap-1.5" aria-label="Trend by timeframe">
              {tfs.map((t) => {
                const a = t.agreement;
                const up = a !== null && a > 0.2;
                const down = a !== null && a < -0.2;
                return (
                  <li
                    key={t.timeframe}
                    className={cn(
                      "inline-flex items-center gap-1 rounded-lg border px-2 py-1 font-mono text-[11px] font-bold break-words",
                      up && "border-emerald-400/30 bg-emerald-400/10 text-emerald-300",
                      down && "border-rose-400/30 bg-rose-400/10 text-rose-300",
                      !up && !down && "border-slate-800 bg-slate-950 text-slate-400",
                    )}
                  >
                    {t.timeframe} <span aria-hidden="true">{mtfArrow(a)}</span> {t.flavor}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </Link>

      {/* Secondary technicals (outside the link so it expands without navigating) */}
      <div className="flex min-w-0 flex-1 flex-col gap-3 px-4 pb-4">
        <details className="rounded-xl border border-slate-800 bg-slate-950/60">
          <summary className="flex min-h-[44px] cursor-pointer items-center px-3 text-xs font-bold text-slate-300 focus-visible:outline-2 focus-visible:outline-cyan-400">
            Technical details
          </summary>
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 border-t border-slate-800/70 px-3 py-3 text-xs">
            <TechRow label="Trend" value={s.trend === "INSUFFICIENT" ? "—" : s.trend} />
            <TechRow label="RSI" value={s.rsi !== null ? s.rsi.toFixed(0) : "—"} mono />
            <TechRow label="Momentum" value={s.momentum === "INSUFFICIENT" ? "—" : s.momentum} />
            <TechRow label="Structure" value={s.marketStructure === "INSUFFICIENT" ? "—" : s.marketStructure} />
            <TechRow label="Volume signal" value={s.volume === "INSUFFICIENT" ? "—" : s.volume} />
            <TechRow label="24h volume" value={market?.dayVolumeNotional != null ? formatVolumeNotional(market.dayVolumeNotional) : "—"} mono />
            <TechRow label="Funding" value={formatFundingRate(market?.fundingRate ?? null)} mono />
            <TechRow label="Open interest" value={formatOpenInterestNotional(market?.openInterestNotional ?? null)} mono />
          </dl>
        </details>

        {/* Why */}
        <div className="min-w-0">
          <p className="mb-0.5 text-[10px] font-bold tracking-widest text-slate-500 uppercase">Why this signal?</p>
          <p className="text-xs leading-relaxed break-words text-slate-300">{why}</p>
        </div>

        <SignalAiButton symbol={r.symbol} signal={s} market={market ?? undefined} />

        <Link
          to={coinHref}
          className="mt-auto flex min-h-[44px] min-w-0 items-center justify-between gap-2 border-t border-slate-800/70 pt-3 text-xs focus-visible:outline-2 focus-visible:outline-cyan-400"
          aria-label={`${r.symbol} details. Open analysis.`}
        >
          <span className="rounded bg-slate-800 px-2 py-1 font-mono text-[10px] font-bold text-slate-400">{s.timeframe} setup</span>
          <span className="font-bold text-cyan-300">View Analysis <span aria-hidden="true">→</span></span>
        </Link>
      </div>
    </article>
  );
});

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

export function FilterGroup({
  label,
  options,
  value,
  onPick,
  labels,
}: {
  label: string;
  options: string[];
  value: string;
  onPick: (v: string) => void;
  /** Optional display overrides keyed by option value. */
  labels?: Record<string, string>;
}) {
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
          {labels?.[o] ?? o}
        </button>
      ))}
    </span>
  );
}
