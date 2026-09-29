import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Card, CardHeader, PageHeader, TableShell } from "../components/ui";
import { CategoryChip } from "../components/SignalCard";
import { ConnectionBadge } from "../components/ConnectionBadge";
import { useMarkets } from "../market/store";
import type { MarketClass } from "../market/classify";
import {
  alertCoinNavigation,
  alertStatusCounts,
  clearAlertHistory,
  EMPTY_ALERT_FILTERS,
  filterAlerts,
  isNavigableAlert,
  markAlertRead,
  markAllAlertsRead,
  subscribeAlerts,
  type AlertFilters,
  type SignalEvent,
  type SignalEventType,
} from "../alerts";
import { formatPriceUsd } from "../lib/format";
import { cn } from "../lib/cn";

const EVENT_OPTIONS: ("ALL" | SignalEventType)[] = [
  "ALL",
  "NEW_SIGNAL",
  "SIGNAL_STRENGTHENED",
  "SIGNAL_WEAKENED",
  "SIGNAL_INVALIDATED",
  "TARGET_REACHED",
  "ENTRY_REACHED",
  "BOUNCE_DETECTED",
  "BREAKOUT_DETECTED",
];

export default function Alerts() {
  const [events, setEvents] = useState<SignalEvent[]>([]);
  const [filters, setFilters] = useState<AlertFilters>({ ...EMPTY_ALERT_FILTERS });
  const [catFilter, setCatFilter] = useState<"ALL" | MarketClass>("ALL");
  const { markets, connection } = useMarkets();
  const navigate = useNavigate();
  const mainSymbols = useMemo(
    () => new Set(markets.filter((m) => !m.symbol.includes(":")).map((m) => m.symbol.toUpperCase())),
    [markets],
  );

  useEffect(() => subscribeAlerts(setEvents), []);

  const prices = useMemo(() => new Map(markets.map((m) => [m.symbol, m.markPrice])), [markets]);
  const filtered = useMemo(
    () => filterAlerts(events, { ...filters, category: catFilter }).slice(0, 200),
    [events, filters, catFilter],
  );
  const counts = useMemo(() => alertStatusCounts(events), [events]);
  const coins = useMemo(() => ["ALL", ...new Set(events.map((e) => e.symbol)).values()].sort(), [events]);

  const offline = connection === "OFFLINE";

  return (
    <div>
      <PageHeader
        title="Alert Center"
        description="Monitor events: new setups, strength changes, targets, invalidations. Deduplicated by stable IDs — never one alert per refresh."
        right={
          <div className="flex items-center gap-2">
            <ConnectionBadge />
            <button onClick={markAllAlertsRead} className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs font-bold text-slate-300 hover:bg-slate-800">
              Mark all as read
            </button>
          </div>
        }
      />

      {offline && (
        <p className="mb-4 rounded-2xl border border-rose-400/30 bg-rose-400/[0.07] px-5 py-3 text-[13px] font-bold tracking-wide text-rose-200">
          MARKET DATA OFFLINE — signal generation paused. No alerts are emitted from stale data; a fresh scan runs on reconnect.
        </p>
      )}

      <div className="mb-4 grid grid-cols-3 gap-3">
        {(["NEW", "ACTIVE", "READ"] as const).map((s) => (
          <div key={s} className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
            <p className="text-[11px] font-semibold tracking-widest text-slate-500 uppercase">{s}</p>
            <p className="mt-1 text-lg font-bold text-white">{counts[s]}</p>
          </div>
        ))}
      </div>

      <Card>
        <CardHeader title="Alert History" subtitle="Timestamp · coin · direction · setup · strength · event · status" />
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-800/70 px-4 py-3 text-xs">
          <select value={filters.coin} onChange={(e) => setFilters({ ...filters, coin: e.target.value })} aria-label="Coin filter" className="min-h-[44px] rounded-lg border border-slate-800 bg-slate-950 px-2 py-1.5 font-bold text-slate-300">
            {coins.map((c) => (
              <option key={c} value={c}>{c === "ALL" ? "All coins" : c}</option>
            ))}
          </select>
          <select value={filters.direction} onChange={(e) => setFilters({ ...filters, direction: e.target.value as AlertFilters["direction"] })} aria-label="Direction filter" className="min-h-[44px] rounded-lg border border-slate-800 bg-slate-950 px-2 py-1.5 font-bold text-slate-300">
            {(["ALL", "LONG", "SHORT"] as const).map((d) => (
              <option key={d} value={d}>{d}</option>
            ))}
          </select>
          <select value={filters.event} onChange={(e) => setFilters({ ...filters, event: e.target.value as AlertFilters["event"] })} aria-label="Event type filter" className="min-h-[44px] rounded-lg border border-slate-800 bg-slate-950 px-2 py-1.5 font-bold text-slate-300">
            {EVENT_OPTIONS.map((t) => (
              <option key={t} value={t}>{t === "ALL" ? "All events" : t.replace(/_/g, " ")}</option>
            ))}
          </select>
          <select value={catFilter} onChange={(e) => setCatFilter(e.target.value as "ALL" | MarketClass)} aria-label="Market category filter" className="min-h-[44px] rounded-lg border border-slate-800 bg-slate-950 px-2 py-1.5 font-bold text-slate-300">
            {(["ALL", "crypto", "stocks", "commodities", "other"] as const).map((c) => (
              <option key={c} value={c}>{c === "ALL" ? "All categories" : c === "crypto" ? "Crypto" : c === "stocks" ? "Stocks" : c === "commodities" ? "Commodities" : "Other"}</option>
            ))}
          </select>
          <button onClick={() => { clearAlertHistory(); }} className="ml-auto rounded-lg border border-slate-800 px-3 py-1.5 font-bold text-slate-500 hover:border-slate-700">
            Clear history
          </button>
        </div>
        <TableShell columns={["Time", "Coin", "Dir", "Setup", "Str", "Entry", "Invalidation", "TP1/2/3", "Event", "Status", ""]} minWidth="1180px">
          {filtered.length === 0 ? (
            <tr>
              <td colSpan={11} className="px-4 py-12 text-center text-sm text-slate-500">
                No alert events yet. Qualifying scan events appear here once — repeats never re-alert.
              </td>
            </tr>
          ) : (
            filtered.map((e) => {
              const s = e.signal;
              const nav = alertCoinNavigation(e);
              const clickable = nav.path !== null && isNavigableAlert(e);
              const openCoin = () => {
                if (!clickable || !nav.path) return;
                if (!e.read) markAlertRead(e.id);
                navigate(nav.path, nav.state ? { state: nav.state } : undefined);
              };
              return (
                <tr
                  key={e.id}
                  onClick={clickable ? openCoin : undefined}
                  title={clickable ? `Open ${e.symbol} analysis` : "Alert has no valid market reference"}
                  className={cn(
                    "border-b border-slate-800/50 text-xs last:border-0 hover:bg-slate-900/50",
                    !e.read && "bg-cyan-400/[0.03]",
                    clickable && "cursor-pointer",
                  )}
                >
                  <td className="px-3 py-2 whitespace-nowrap text-slate-400">{new Date(e.timestamp).toLocaleString()}</td>
                  <td className="px-3 py-2">
                    <span className={cn("font-bold", clickable ? "text-white" : "text-slate-500")}>
                      {e.symbol || "(unknown)"}{e.watched ? " ★" : ""}
                    </span>
                    <span className="ml-1 font-mono text-[11px] text-slate-500">{formatPriceUsd(prices.get(e.symbol) ?? null, e.symbol)}</span>
                    <span className="mt-0.5 block w-fit"><CategoryChip symbol={e.symbol} category={e.category} mainSymbols={mainSymbols} /></span>
                  </td>
                  <td className={cn("px-3 py-2 font-bold", e.direction === "LONG" ? "text-emerald-300" : "text-rose-300")}>{e.direction}</td>
                    <td className="px-3 py-2 font-mono text-[11px] text-slate-400">{e.setupType}</td>
                  <td className="px-3 py-2 font-mono font-bold text-slate-100">
                    {e.previousStrength !== null ? `${e.previousStrength}→` : ""}{e.currentStrength}
                  </td>
                  <td className="px-3 py-2 font-mono text-slate-300">{s.entryLow !== null ? `${s.entryLow}–${s.entryHigh}` : "—"}</td>
                  <td className="px-3 py-2 font-mono text-slate-300">{s.invalidation ?? "—"}</td>
                  <td className="px-3 py-2 font-mono text-slate-300">{s.tp1 !== null ? `${s.tp1}/${s.tp2}/${s.tp3}` : "—"}</td>
                  <td className="px-3 py-2">
                    <span className="inline-flex rounded-full bg-slate-800 px-2 py-0.5 text-[10px] font-bold tracking-wider text-slate-300">
                      {e.type.replace(/_/g, " ")}
                    </span>
                    {e.detail && <span className="ml-1 font-mono text-[10px] text-cyan-300">{e.detail}</span>}
                  </td>
                  <td className="px-3 py-2">
                    <span className={cn("inline-flex rounded-full px-2 py-0.5 text-[10px] font-bold tracking-wider", e.status === "NEW" && "bg-cyan-400/10 text-cyan-300", e.status === "ACTIVE" && "bg-slate-800 text-slate-300", e.status === "READ" && "text-slate-600")}>
                      {e.status}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    {!e.read && (
                      <button
                        onClick={(ev) => {
                          ev.stopPropagation();
                          markAlertRead(e.id);
                        }}
                        className="rounded-lg border border-slate-800 px-2 py-1 text-[11px] font-bold text-slate-400 hover:border-slate-600"
                      >
                        Read
                      </button>
                    )}
                  </td>
                </tr>
              );
            })
          )}
        </TableShell>
        <p className="border-t border-slate-800/70 px-5 py-3 text-[11px] text-slate-600">
          Click a coin for full detail (AI explanation, news, timeline). Strength is confluence, never a probability.
        </p>
      </Card>
    </div>
  );
}
