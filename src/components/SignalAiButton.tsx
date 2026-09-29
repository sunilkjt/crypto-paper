import { useState } from "react";
import { buildAiInput, getAiAnalysis, useAiMode } from "../ai";
import type { Signal } from "../analysis/signal";
import { getCachedCandles } from "../market/hyperliquid";
import { getCandleWindow } from "../market/hyperliquid/timeframes";
import type { Candle, Market, Timeframe } from "../market/hyperliquid/types";

const TFS: Timeframe[] = ["4h", "1h", "15m", "5m"];

type Phase = "idle" | "loading" | "ok" | "unavailable";

/**
 * On-demand AI explanation for one scanned signal. Fires ONLY on tap —
 * never on ticks, renders, or scans. Reuses the shared orchestrator, so the
 * cache (signal-bound key), 10s throttle, in-flight dedupe and validation
 * (direction-echo lock) all apply exactly as on the coin page.
 */
export function SignalAiButton({
  symbol,
  signal,
  market,
}: {
  symbol: string;
  signal: Signal;
  market: Market | undefined;
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [summary, setSummary] = useState<string | null>(null);
  const [cached, setCached] = useState(false);
  const [busy, setBusy] = useState(false);
  const aiMode = useAiMode();
  if (aiMode === "off") return null;

  const explain = async () => {
    if (busy) return;
    setBusy(true);
    setPhase("loading");
    try {
      const candlesByTf: Partial<Record<Timeframe, Candle[]>> = {};
      for (const tf of TFS) {
        const w = getCandleWindow(tf, Date.now(), 300);
        const res = await getCachedCandles(symbol.toUpperCase(), tf, w.startTime, w.endTime);
        candlesByTf[tf] = res.candles;
      }
      if (!candlesByTf["15m"] || candlesByTf["15m"].length === 0) {
        setPhase("unavailable");
        return;
      }
      const input = buildAiInput({ symbol, market, candlesByTf, signal, news: [] });
      const res = await getAiAnalysis({ input, timeframe: signal.timeframe });
      if (res.status === "ok" && res.analysis) {
        setSummary(res.analysis.summary);
        setCached(res.cached);
        setPhase("ok");
      } else {
        setPhase("unavailable");
      }
    } catch {
      setPhase("unavailable");
    } finally {
      setBusy(false);
    }
  };

  if (phase === "ok" && summary) {
    return (
      <div className="min-w-0 rounded-xl border border-violet-400/25 bg-violet-400/[0.06] p-3">
        <p className="flex items-center gap-1.5 text-[10px] font-bold tracking-widest text-violet-300/90 uppercase">
          <span aria-hidden="true">✨</span> AI Explanation
          {cached && (
            <span className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[9px] text-slate-400">CACHED</span>
          )}
        </p>
        <p className="mt-1 text-xs leading-relaxed break-words text-slate-200">{summary}</p>
      </div>
    );
  }

  if (phase === "loading") {
    return (
      <p role="status" className="animate-pulse text-xs font-bold text-violet-200">
        <span aria-hidden="true">✨</span> Analyzing signal…
      </p>
    );
  }

  return (
    <div className="min-w-0 space-y-1.5">
      {phase === "unavailable" && (
        <p className="text-[11px] break-words text-slate-500">AI unavailable — showing technical explanation.</p>
      )}
      <button
        onClick={() => void explain()}
        disabled={busy}
        className="inline-flex min-h-[44px] items-center gap-1.5 rounded-xl border border-violet-400/40 bg-violet-400/10 px-4 text-xs font-bold text-violet-200 hover:bg-violet-400/20 focus-visible:outline-2 focus-visible:outline-cyan-400 disabled:opacity-50"
      >
        <span aria-hidden="true">✨</span> {phase === "unavailable" ? "Retry AI explanation" : "AI Explanation"}
      </button>
    </div>
  );
}
