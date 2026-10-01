import { useScannerHealth, useServerCounts } from "../supabase/history";
import { cn } from "../lib/cn";

/** Freshness bar shared with the Telegram bot (cron ticks every 5 min). */
const STALE_AFTER_MS = 15 * 60_000;
const EXPECTED_EVERY_MS = 5 * 60_000;

function timeOf(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/**
 * Compact 24/7 scanner health for the Dashboard. Reads the same
 * scanner_state the cron writes and the bot reads — no new data paths.
 * Silent (renders nothing) when signed out, so logged-out users see no
 * change at all.
 */
export function ScannerHealthPanel() {
  const { health, loading, error, refresh } = useScannerHealth(true);

  if (!loading && !error && !health) return null;

  const fresh = health?.lastRunAt !== null && health?.lastRunAt !== undefined && Date.now() - (health?.lastRunAt ?? 0) <= STALE_AFTER_MS;
  const dot = loading || error ? "bg-amber-300" : fresh ? "bg-emerald-400" : "bg-rose-500";
  const label = loading ? "Checking…" : error ? "Degraded" : fresh ? "Healthy" : "Stale";
  const cats = health?.perCategory ?? {};
  const wd = health?.watchdogAlerting;

  return (
    <div className="mt-3 rounded-xl border border-slate-800 bg-slate-900/60 px-4 py-3 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-bold tracking-widest text-slate-500 uppercase">Scanner</span>
        <span className="inline-flex items-center gap-1.5 font-bold text-slate-200">
          <span className={cn("h-1.5 w-1.5 rounded-full", dot)} />
          {label}
        </span>
        {!loading && !error && health?.lastRunAt != null && (
          <span className="text-slate-500">
            Last scan {timeOf(health.lastRunAt)} · next ~{timeOf(health.lastRunAt + EXPECTED_EVERY_MS)}
          </span>
        )}
        <button
          onClick={refresh}
          aria-label="Refresh scanner health"
          className="ml-auto min-h-[44px] rounded-lg border border-slate-800 px-3 font-bold text-slate-300 hover:bg-slate-900"
        >
          ↻
        </button>
      </div>
      {!loading && !error && health && (
        <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5 font-mono text-[11px] text-slate-400">
          {["crypto", "stocks", "commodities"].map((c) => {
            const s = cats[c];
            return (
              <span key={c}>
                {c}: {s ? `${s.scanned}/${s.signals}` : "—"}
              </span>
            );
          })}
          <span>
            Watchdog: {wd === true ? "alerting" : wd === false ? "armed" : "unknown"}
          </span>
        </div>
      )}
      {error && <p className="mt-1 text-[11px] text-amber-300">{error}</p>}
    </div>
  );
}

/** One-line 24h server signal counts (nothing when signed out or failing). */
export function ServerSignalCounts() {
  const { counts, loading, error } = useServerCounts(true);
  if (loading) return <p className="px-5 pt-3 text-[11px] text-slate-600">Server (24h): …</p>;
  if (error || !counts) return null;
  return (
    <p className="px-5 pt-3 font-mono text-[11px] text-slate-500">
      Server (24h): {counts.crypto} crypto · {counts.stocks} stocks · {counts.commodities} commodities
    </p>
  );
}
