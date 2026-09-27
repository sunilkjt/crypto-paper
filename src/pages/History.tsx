import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Card, CardHeader, PageHeader, TableShell } from "../components/ui";
import { ConnectionBadge } from "../components/ConnectionBadge";
import {
  clearJournal,
  loadJournal,
  upsertJournalSignal,
  type JournalEntry,
} from "../signals/journal";
import { trackOutcome } from "../signals/outcomes";
import { getCachedCandles } from "../market/hyperliquid";
import { getCandleWindow } from "../market/hyperliquid/timeframes";
import type { Timeframe } from "../market/hyperliquid/types";
import { cn } from "../lib/cn";

type StatusFilter = "ALL" | "ACTIVE" | "NEW" | "STRENGTHENING" | "WEAKENING" | "INVALIDATED" | "COMPLETED" | "EXPIRED";

const ACTIVE_STATUSES = ["NEW", "ACTIVE", "STRENGTHENING", "WEAKENING"];

/**
 * Signal journal: every recorded setup with lifecycle status and observed
 * outcomes (TP touches, invalidation, MFE/MAE — touches, never profit
 * claims). Outcomes refresh for open signals on visit, bounded to 15.
 */
export default function History() {
  const [entries, setEntries] = useState<JournalEntry[]>(() => loadJournal());
  const [filter, setFilter] = useState<StatusFilter>("ALL");
  const [refreshing, setRefreshing] = useState(false);

  const refreshOutcomes = async () => {
    const open = loadJournal()
      .filter((e) => ACTIVE_STATUSES.includes(e.status))
      .sort((a, b) => b.lastSeen - a.lastSeen)
      .slice(0, 15);
    if (open.length === 0) return;
    setRefreshing(true);
    try {
      await Promise.all(
        open.map(async (e) => {
          try {
            const tf = (["5m", "15m", "1h", "4h"].includes(e.timeframe) ? e.timeframe : "15m") as Timeframe;
            const w = getCandleWindow(tf, Date.now(), 300);
            const res = await getCachedCandles(e.symbol, tf, w.startTime, w.endTime);
            const follow = res.candles.filter((c) => c.timestamp > e.dataTimestamp);
            if (follow.length === 0 || e.entryLow === null || e.entryHigh === null) return;
            const entryMid = (e.entryLow + e.entryHigh) / 2;
            const risk = e.direction === "LONG" ? entryMid - (e.invalidation ?? entryMid) : (e.invalidation ?? entryMid) - entryMid;
            if (!(risk > 0) || e.invalidation === null || e.tp1 === null || e.tp2 === null || e.tp3 === null) return;
            const outcome = trackOutcome({
              direction: e.direction,
              entryMid,
              risk,
              invalidation: e.invalidation,
              tp1: e.tp1,
              tp2: e.tp2,
              tp3: e.tp3,
              followCandles: follow,
            });
            // Terminal touches advance the lifecycle honestly.
            let status = e.status;
            if (outcome.invalidationReached && (e.status === "NEW" || e.status === "ACTIVE" || e.status === "WEAKENING" || e.status === "STRENGTHENING")) {
              status = "INVALIDATED";
            } else if (outcome.tp3Reached && status !== "COMPLETED") {
              status = "COMPLETED";
            }
            upsertJournalSignal({ ...e, status, outcome, newsHeadlines: e.newsHeadlines, now: Date.now() });
          } catch {
            // per-entry isolation: one bad refresh never blocks the rest
          }
        }),
      );
    } finally {
      setEntries(loadJournal());
      setRefreshing(false);
    }
  };

  useEffect(() => {
    void refreshOutcomes();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filtered = useMemo(() => {
    const list = filter === "ALL" ? entries : filter === "ACTIVE" ? entries.filter((e) => ACTIVE_STATUSES.includes(e.status)) : entries.filter((e) => e.status === filter);
    return [...list].sort((a, b) => b.lastSeen - a.lastSeen);
  }, [entries, filter]);

  const tp1Hits = entries.filter((e) => e.outcome?.tp1Reached).length;
  const invHits = entries.filter((e) => e.status === "INVALIDATED").length;

  return (
    <div>
      <PageHeader
        title="Signal History"
        description="Journaled setups with lifecycle status and observed level touches. Touches are facts, not profit claims."
        right={
          <div className="flex items-center gap-2">
            <ConnectionBadge showLabel={false} />
            <button
              onClick={() => {
                clearJournal();
                setEntries([]);
              }}
              className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs font-bold text-slate-300 hover:bg-slate-800"
            >
              Clear journal
            </button>
          </div>
        }
      />

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          ["Total Signals", String(entries.length), "journaled setups"],
          ["Active", String(entries.filter((e) => ACTIVE_STATUSES.includes(e.status)).length), "open lifecycle states"],
          ["TP1 Touched", String(tp1Hits), "observed level touches"],
          ["Invalidated", String(invHits), "stopped setups"],
        ].map(([k, v, s]) => (
          <div key={k} className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
            <p className="text-[11px] font-semibold tracking-widest text-slate-500 uppercase">{k}</p>
            <p className="mt-1 text-lg font-bold text-white">{v}</p>
            <p className="text-xs text-slate-500">{s}</p>
          </div>
        ))}
      </div>

      <Card>
        <CardHeader
          title="All Signals"
          subtitle="ID · Time · Coin · Direction · Setup · Entry · Invalidation · TPs · Strength · Quality · Status · Outcome"
          right={
            <button
              onClick={() => void refreshOutcomes()}
              disabled={refreshing}
              className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs font-bold text-slate-200 disabled:opacity-40 hover:bg-slate-800"
            >
              {refreshing ? "Checking levels…" : "Refresh outcomes"}
            </button>
          }
        />
        <div className="flex flex-wrap gap-1.5 border-b border-slate-800/70 px-4 py-3">
          {(["ALL", "ACTIVE", "NEW", "STRENGTHENING", "WEAKENING", "INVALIDATED", "COMPLETED", "EXPIRED"] as StatusFilter[]).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={cn("rounded-lg border px-2.5 py-1 text-[11px] font-bold", filter === f ? "border-cyan-400/50 bg-cyan-400/10 text-cyan-200" : "border-slate-800 text-slate-500 hover:border-slate-700")}
            >
              {f}
            </button>
          ))}
        </div>
        <TableShell
          columns={["ID", "Time", "Coin", "Dir", "Setup", "Entry", "Invalidation", "TP1/2/3", "Str", "Quality", "Status", "Outcome"] as const}
          minWidth="1240px"
        >
          {filtered.length === 0 ? (
            <tr>
              <td colSpan={12} className="px-4 py-14 text-center">
                <p className="text-sm font-semibold text-slate-300">No signals recorded yet.</p>
                <p className="mx-auto mt-1 max-w-md text-xs text-slate-500">
                  Run a scan — qualifying setups journal automatically with stable deduplicated IDs.
                </p>
              </td>
            </tr>
          ) : (
            filtered.slice(0, 100).map((e) => (
              <tr key={e.id} className="border-b border-slate-800/50 text-xs last:border-0 hover:bg-slate-900/50">
                <td className="px-3 py-2 font-mono text-[10px] text-slate-500" title={e.id}>{e.id.split("|").slice(0, 4).join("|")}</td>
                <td className="px-3 py-2 whitespace-nowrap text-slate-400">{new Date(e.firstSeen).toLocaleString()}</td>
                <td className="px-3 py-2">
                  <Link to={`/coin/${e.symbol}`} className="font-bold text-white hover:text-cyan-300">{e.symbol}</Link>
                </td>
                <td className="px-3 py-2">
                  <span className={cn("inline-flex rounded-md border px-2 py-0.5 text-[11px] font-bold", e.direction === "LONG" ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-300" : "border-rose-400/30 bg-rose-400/10 text-rose-300")}>
                    {e.direction}
                  </span>
                </td>
                <td className="px-3 py-2 font-mono text-[11px] text-slate-400">{e.setupType}</td>
                <td className="px-3 py-2 font-mono text-slate-300">{e.entryLow !== null ? `${e.entryLow}–${e.entryHigh}` : "—"}</td>
                <td className="px-3 py-2 font-mono text-slate-300">{e.invalidation ?? "—"}</td>
                <td className="px-3 py-2 font-mono text-slate-300">{e.tp1 !== null ? `${e.tp1}/${e.tp2}/${e.tp3}` : "—"}</td>
                <td className="px-3 py-2 font-mono font-bold text-slate-100">{e.strength}</td>
                <td className="px-3 py-2 text-[11px] whitespace-nowrap text-slate-400">{e.quality}</td>
                <td className="px-3 py-2">
                  <span className={cn("inline-flex rounded-full px-2 py-0.5 text-[10px] font-bold tracking-wider", e.status === "INVALIDATED" && "bg-rose-400/10 text-rose-300", e.status === "COMPLETED" && "bg-emerald-400/10 text-emerald-300", e.status === "EXPIRED" && "bg-slate-800 text-slate-500", ACTIVE_STATUSES.includes(e.status) && "bg-cyan-400/10 text-cyan-300")}>
                    {e.status}
                  </span>
                </td>
                <td className="px-3 py-2 font-mono text-[11px] text-slate-400" title={e.outcome ? `MFE ${e.outcome.mfeR}R · MAE ${e.outcome.maeR}R · ${e.outcome.barsObserved} bars` : "No follow-up candles yet"}>
                  {e.outcome ? (
                    <>
                      <span className={e.outcome.tp1Reached ? "text-emerald-300" : ""}>T1{e.outcome.tp1Reached ? "✓" : "·"}</span>{" "}
                      <span className={e.outcome.tp2Reached ? "text-emerald-300" : ""}>T2{e.outcome.tp2Reached ? "✓" : "·"}</span>{" "}
                      <span className={e.outcome.tp3Reached ? "text-emerald-300" : ""}>T3{e.outcome.tp3Reached ? "✓" : "·"}</span>{" "}
                      <span className={e.outcome.invalidationReached ? "text-rose-300" : ""}>X{e.outcome.invalidationReached ? "✓" : "·"}</span>
                    </>
                  ) : "—"}
                </td>
              </tr>
            ))
          )}
        </TableShell>
      </Card>
    </div>
  );
}
