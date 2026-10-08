import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { CandleChart, type ChartLevel } from "./CandleChart";
import type { ResolvedSignal } from "../analytics/performance";
import type { Candle, Timeframe } from "../market/hyperliquid/types";
import { getCachedCandles } from "../market/hyperliquid";
import { getCandleWindow, isSupportedTimeframe, timeframeToMs } from "../market/hyperliquid/timeframes";
import { cn } from "../lib/cn";

function fmt(v: number | null, digits = 4): string {
  if (v === null || !Number.isFinite(v)) return "Not recorded";
  return v.toLocaleString("en-US", { maximumFractionDigits: digits });
}

function fmtWhen(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms <= 0) return "—";
  return new Date(ms).toLocaleString();
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

/**
 * Historical signal viewer. Displays ONLY stored signal_history fields
 * plus fetched OHLCV for context — it never regenerates the signal, never
 * recomputes indicators, and never determines outcomes (OPEN stays OPEN;
 * only the resolver writes verdicts).
 */
export function SignalDetailsModal({
  signal,
  liveMark,
  onClose,
}: {
  signal: ResolvedSignal;
  liveMark: number | null;
  onClose: () => void;
}) {
  const tf: Timeframe = isSupportedTimeframe(signal.timeframe) ? signal.timeframe : "15m";
  const [candles, setCandles] = useState<Candle[] | null>(null);
  const [chartError, setChartError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Historical context window: ~60 bars before the signal through the
  // outcome (or now for OPEN). Display only — outcome math never runs here.
  useEffect(() => {
    let cancelled = false;
    setCandles(null);
    setChartError(null);
    const span = timeframeToMs(tf);
    const start = signal.firstSeen - 60 * span;
    const end = Math.min(signal.outcomeAt ?? Date.now(), Date.now());
    const w = getCandleWindow(tf, end, Math.min(200, Math.max(10, Math.ceil((end - start) / span))));
    void getCachedCandles(signal.symbol, tf, w.startTime, w.endTime)
      .then((res) => {
        if (!cancelled) setCandles(res.candles);
      })
      .catch((err: unknown) => {
        if (!cancelled) setChartError(err instanceof Error ? err.message : "Unable to load candles.");
      });
    return () => {
      cancelled = true;
    };
  }, [signal.symbol, signal.firstSeen, signal.outcomeAt, tf]);

  const levels: ChartLevel[] = useMemo(() => {
    const lv: ChartLevel[] = [];
    if (signal.entryMid !== null) lv.push({ price: signal.entryMid, label: "Entry", color: "#22d3ee", dashed: false });
    if (signal.invalidation !== null) lv.push({ price: signal.invalidation, label: "STOP", color: "#fb7185" });
    if (signal.tp1 !== null) lv.push({ price: signal.tp1, label: "TP1", color: "#34d399" });
    if (signal.tp2 !== null) lv.push({ price: signal.tp2, label: "TP2", color: "#34d399" });
    if (signal.tp3 !== null) lv.push({ price: signal.tp3, label: "TP3", color: "#34d399" });
    if (signal.activationPrice !== null) lv.push({ price: signal.activationPrice, label: "Activated", color: "#fbbf24" });
    return lv;
  }, [signal]);

  const stored: [string, string][] = [
    ["ID", signal.id],
    ["Symbol", signal.symbol],
    ["Category", signal.category.toUpperCase()],
    ["Direction", signal.direction],
    ["Score", String(signal.score)],
    ["Timeframe", signal.timeframe],
    ["Setup", signal.setupType ?? "Not recorded"],
    ["Quality", signal.quality ?? "Not recorded"],
    ["Entry type", signal.entryType ?? "Not recorded (legacy)"],
    ["Entry low", fmt(signal.entryLow)],
    ["Entry high", fmt(signal.entryHigh)],
    ["Stop / invalidation", fmt(signal.invalidation)],
    ["TP1", fmt(signal.tp1)],
    ["TP2", fmt(signal.tp2)],
    ["TP3", fmt(signal.tp3)],
    ["R:R", signal.riskReward !== null ? `1 : ${signal.riskReward}` : "Not recorded"],
    ["Signal time", fmtWhen(signal.firstSeen)],
    ["Last seen", fmtWhen(signal.lastSeen)],
    ["Outcome", signal.verdict],
    ["Realized R", signal.realizedR !== null ? `${signal.realizedR >= 0 ? "+" : ""}${signal.realizedR}R` : "—"],
    ["Activation price", signal.activationPrice !== null ? `${fmt(signal.activationPrice)} (estimated)` : "—"],
    ["Activation time", fmtWhen(signal.activationTs)],
    ["Outcome time", fmtWhen(signal.outcomeAt)],
    ["Resolved at", fmtWhen(signal.resolvedAt)],
    ["Ambiguous bar", signal.ambiguous ? "YES — conservative fallback used" : "No"],
    ["Exit path", signal.decidedBy || "—"],
  ];

  const isOpen = signal.verdict === "OPEN";
  const steps: { label: string; detail: string; done: boolean }[] = [
    { label: "SIGNAL", detail: `Generated ${fmtWhen(signal.firstSeen)}`, done: true },
    {
      label: signal.entryType === "RETEST" ? "WAIT FOR RETEST" : "ENTRY",
      detail:
        signal.entryType === null
          ? "Legacy signal — entry tracking not recorded"
          : signal.entryType === "MARKET"
            ? "Price inside the entry zone at signal time"
            : `Zone ${fmt(signal.entryLow)} – ${fmt(signal.entryHigh)} (actual activation/touch decides the trade)`,
      done: true,
    },
    {
      label: "ACTIVATION",
      detail:
        signal.activationTs !== null
          ? `Activated ${fmtWhen(signal.activationTs)} at ~${fmt(signal.activationPrice)} (estimated)`
          : signal.verdict === "INVALIDATED"
            ? "Never activated — invalidated first"
            : signal.verdict === "NO_FILL"
              ? "Never activated — zone untouched"
              : "Not activated",
      done: signal.activationTs !== null,
    },
    {
      label: "TP / STOP",
      detail: signal.decidedBy.startsWith("PENDING") ? "Awaiting resolution" : signal.decidedBy || "—",
      done: signal.outcomeAt !== null,
    },
    {
      label: "FINAL OUTCOME",
      detail:
        signal.verdict === "OPEN"
          ? "OPEN — awaiting resolution (only the resolver determines outcomes)"
          : `${signal.verdict}${signal.realizedR !== null ? ` ${signal.realizedR >= 0 ? "+" : ""}${signal.realizedR}R` : ""}`,
      done: !isOpen && signal.verdict !== "UNKNOWN",
    },
  ];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-3 sm:p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`Historical signal ${signal.symbol} ${signal.direction}`}
    >
      <div
        className="max-h-[92vh] w-full max-w-3xl overflow-y-auto rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 z-10 border-b border-slate-800 bg-slate-900/95 px-5 py-4 backdrop-blur">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-base font-extrabold tracking-tight text-white">
                {signal.symbol} · {signal.direction} · Score {signal.score}
              </h2>
              <p className="mt-0.5 text-xs text-slate-400">
                Historical signal — stored record, never recalculated
              </p>
            </div>
            <button
              onClick={onClose}
              aria-label="Close signal details"
              className="min-h-[44px] min-w-[44px] rounded-xl border border-slate-700 px-3 text-sm font-bold text-slate-300 hover:bg-slate-800"
            >
              ✕
            </button>
          </div>
        </div>

        <div className="space-y-4 p-4 sm:p-5">
          {/* Outcome timeline */}
          <section aria-label="Outcome timeline">
            <p className="mb-2 text-[11px] font-bold tracking-widest text-slate-500 uppercase">Outcome path</p>
            <ol className="space-y-0">
              {steps.map((s, i) => (
                <li key={s.label} className="flex gap-3">
                  <span className="flex flex-col items-center">
                    <span
                      className={cn(
                        "mt-1 h-2.5 w-2.5 shrink-0 rounded-full",
                        s.done ? "bg-cyan-400" : "border border-slate-600 bg-transparent",
                      )}
                    />
                    {i < steps.length - 1 && <span className="w-px flex-1 bg-slate-800" />}
                  </span>
                  <span className="pb-3">
                    <span className="block text-xs font-bold tracking-wider text-slate-200">{s.label}</span>
                    <span className="block text-xs text-slate-400">{s.detail}</span>
                  </span>
                </li>
              ))}
            </ol>
          </section>

          {/* Historical chart (display only) */}
          <section aria-label="Historical chart">
            <p className="mb-2 text-[11px] font-bold tracking-widest text-slate-500 uppercase">
              Historical chart · {tf} · signal bar {fmtWhen(signal.firstSeen)}
            </p>
            <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-2">
              {candles === null && chartError === null ? (
                <p className="flex h-[200px] items-center justify-center text-xs text-slate-500">Loading historical candles…</p>
              ) : chartError !== null ? (
                <p className="px-4 py-8 text-center text-xs text-slate-500">
                  Chart unavailable: {chartError} Levels below are unaffected.
                </p>
              ) : (
                <CandleChart candles={candles ?? []} levels={levels} />
              )}
            </div>
          </section>

          {/* Stored record */}
          <section aria-label="Stored signal record">
            <p className="mb-2 text-[11px] font-bold tracking-widest text-slate-500 uppercase">Stored record (signal_history)</p>
            <dl className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
              {stored.map(([k, v]) => (
                <div key={k} className="flex min-w-0 items-baseline justify-between gap-2 rounded-lg border border-slate-800/70 bg-slate-950/60 px-3 py-1.5">
                  <dt className="shrink-0 text-[11px] text-slate-500">{k}</dt>
                  <dd className="min-w-0 text-right font-mono text-xs break-words text-slate-200">{v}</dd>
                </div>
              ))}
            </dl>
            {signal.reasons.length > 0 && (
              <div className="mt-1.5 rounded-lg border border-slate-800/70 bg-slate-950/60 px-3 py-2">
                <p className="text-[11px] text-slate-500">Reasons</p>
                <ul className="mt-1 space-y-0.5 text-xs text-slate-300">
                  {signal.reasons.map((r, i) => (
                    <li key={i}>· {r}</li>
                  ))}
                </ul>
              </div>
            )}
          </section>

          {/* OPEN live section — strictly separated from stored data */}
          {isOpen && (
            <section aria-label="Live status" className="rounded-xl border border-cyan-400/25 bg-cyan-400/[0.05] p-4">
              <p className="mb-2 text-[11px] font-bold tracking-widest text-cyan-300/90 uppercase">Live status (not part of the stored record)</p>
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2">
                  <p className="text-[11px] text-slate-500">Elapsed since signal</p>
                  <p className="mt-0.5 font-mono font-bold text-slate-100">{fmtAge(Date.now() - signal.firstSeen)}</p>
                </div>
                <div className="rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2">
                  <p className="text-[11px] text-slate-500">Current market price</p>
                  <p className="mt-0.5 font-mono font-bold text-slate-100">
                    {liveMark !== null ? liveMark.toLocaleString("en-US", { maximumFractionDigits: 4 }) : "unavailable"}
                  </p>
                </div>
                <div className="col-span-2 rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2">
                  <p className="text-[11px] text-slate-500">Entry status</p>
                  <p className="mt-0.5 font-bold text-slate-100">
                    {signal.entryType === "RETEST" ? "WAIT FOR RETEST" : signal.entryType === "MARKET" ? "READY" : "Not recorded"}
                  </p>
                </div>
              </div>
              <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
                Still OPEN — only the resolver determines the official outcome. Nothing here is a verdict.
              </p>
            </section>
          )}

          <div className="flex flex-wrap gap-2">
            <Link
              to={`/coin/${signal.symbol}`}
              className="min-h-[44px] rounded-xl border border-slate-700 px-4 py-2 text-xs font-bold text-slate-200 hover:bg-slate-800"
            >
              Open live {signal.symbol} analysis →
            </Link>
            <span className="inline-flex min-h-[44px] items-center px-2 text-[11px] text-slate-600">
              Live analysis reflects current markets — this record stays frozen.
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
