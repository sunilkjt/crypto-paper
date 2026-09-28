import { useEffect, useMemo, useState } from "react";
import { Card, CardHeader, PageHeader } from "../components/ui";
import { CandleChart, type ChartLevel } from "../components/CandleChart";
import { ConnectionBadge } from "../components/ConnectionBadge";
import { AuthPanel, CloudSyncBadge } from "../components/AuthPanel";
import { usePaperCloudSync } from "../supabase/usePaperCloudSync";
import { getSupabase } from "../supabase/client";
import { useAuth } from "../supabase/auth";
import { useMarkets } from "../market/store";
import { useScan } from "../scanner";
import { useCandles } from "../market/useCandles";
import {
  getSharedPaperEngine,
  realizedR,
  unrealizedFor,
  type PaperPosition,
  type PaperSnapshot,
} from "../paper";
import type { Timeframe } from "../market/hyperliquid/types";
import { cn } from "../lib/cn";

const SAFETY = "PAPER TRADING · SIMULATION ONLY · NO REAL ORDERS — never enter keys, seeds, or exchange credentials anywhere here.";

function fmt(n: number | null | undefined, d = 4): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US", { maximumFractionDigits: d });
}

export default function PaperTrading() {
  const engine = useMemo(() => getSharedPaperEngine(), []);
  const [snap, setSnap] = useState<PaperSnapshot>(() => engine.getSnapshot());
  const { markets } = useMarkets();
  const { summary } = useScan();
  const [balanceInput, setBalanceInput] = useState(String(snap.config.startingBalance));
  const [riskInput, setRiskInput] = useState(String(snap.config.riskPerTrade * 100));
  const [autoMin, setAutoMin] = useState(String(snap.config.autoPaperTrading ? snap.config.autoMinStrength : 75));
  const [confirmReset, setConfirmReset] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [coinFilter, setCoinFilter] = useState("ALL");
  const [migrating, setMigrating] = useState(false);
  const autoTaken = useMemo(() => new Set<string>(), []);

  useEffect(() => engine.subscribe(setSnap), [engine]);

  const marks = useMemo(() => {
    const m = new Map<string, number>();
    for (const mk of markets) {
      if (mk.markPrice !== null) m.set(mk.symbol, mk.markPrice);
    }
    return m;
  }, [markets]);

  // Cloud sync (multi-device): same login => same balance/positions/history.
  // Engine math untouched; this only persists + rehydrates snapshots.
  const cloud = usePaperCloudSync(engine, marks);
  const { user } = useAuth();

  // Never display a pre-cloud local default as the account: while signed in
  // and the cloud account is still loading, show a loader instead of $1,000.
  const cloudLoading = !!user && !cloud.hydrated && cloud.status === "loading";

  // Keep config inputs in step with the authoritative config (e.g. cloud
  // account uses $100 while this device defaulted to $1,000). Typing never
  // triggers this — only real config changes do.
  useEffect(() => {
    setBalanceInput(String(snap.config.startingBalance));
    setRiskInput(String(snap.config.riskPerTrade * 100));
  }, [snap.config.startingBalance, snap.config.riskPerTrade]);

  // Drive open simulated positions off live marks.
  useEffect(() => {
    let changed = false;
    for (const p of engine.getSnapshot().positions) {
      if (p.closedAt !== null) continue;
      const mark = marks.get(p.symbol);
      if (mark === undefined) continue;
      const closed = engine.tick(p.symbol, mark);
      if (closed.length > 0) changed = true;
    }
    if (changed || true) engine.touch(marks);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [marks]);

  // AUTO PAPER TRADING (simulation only): take qualifying NEW scan signals.
  useEffect(() => {
    const cfg = engine.getSnapshot().config;
    if (!cfg.autoPaperTrading || !summary) return;
    for (const r of summary.results) {
      if (!r.id || r.signal.direction === "WAIT" || r.signal.signalStrength < cfg.autoMinStrength) continue;
      if (autoTaken.has(r.id)) continue;
      if (r.signal.entryLow === null || r.signal.entryHigh === null || r.signal.invalidation === null) continue;
      const mark = marks.get(r.symbol);
      if (mark === undefined) continue;
      const entry = mark;
      const opened = engine.open(
        {
          symbol: r.symbol,
          timeframe: r.signal.timeframe,
          setupType: r.setupType,
          direction: r.signal.direction,
          entry,
          invalidation: r.signal.invalidation,
          tp1: r.signal.tp1 ?? entry,
          tp2: r.signal.tp2 ?? entry,
          tp3: r.signal.tp3 ?? entry,
          strength: r.signal.signalStrength,
        },
        marks,
      );
      if (opened) autoTaken.add(r.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [summary]);

  const open = snap.positions.filter((p) => p.closedAt === null);
  const closed = snap.positions.filter((p) => p.closedAt !== null);
  const equity = open.reduce((a, p) => a + unrealizedFor(p, marks.get(p.symbol) ?? NaN), snap.balance);
  const totalPnl = equity - snap.config.startingBalance;
  const winRate = snap.closedCount > 0 ? (snap.wins / snap.closedCount) * 100 : 0;
  const avgR =
    closed.length > 0 ? closed.reduce((a, p) => a + realizedR(p), 0) / closed.length : 0;
  const grossPos = closed.filter((p) => realizedR(p) > 0).reduce((a, p) => a + (p.realized - p.fees), 0);
  const grossNeg = Math.abs(closed.filter((p) => realizedR(p) <= 0).reduce((a, p) => a + (p.realized - p.fees), 0));
  const profitFactor = grossNeg > 0 ? grossPos / grossNeg : grossPos > 0 ? Infinity : 0;

  const coins = useMemo(() => ["ALL", ...new Set(closed.map((p) => p.symbol))], [closed]);
  const history = useMemo(() => {
    const list = coinFilter === "ALL" ? closed : closed.filter((p) => p.symbol === coinFilter);
    return [...list].sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0)).slice(0, 100);
  }, [closed, coinFilter]);

  const tpRate = (n: 1 | 2 | 3) => {
    if (closed.length === 0) return "—";
    const hit = closed.filter((p) => 3 - p.thirdsRemaining >= n).length;
    return `${Math.round((hit / closed.length) * 100)}%`;
  };

  const fresh = snap.positions.length === 0 && snap.closedCount === 0;
  const applyConfig = () => {
    const ok = engine.reconfigure({
      ...snap.config,
      startingBalance: Number(balanceInput) || 1000,
      riskPerTrade: (Number(riskInput) || 1) / 100,
      autoMinStrength: Number(autoMin) || 75,
    });
    if (!ok) alert("Config can only change on a fresh account — reset first.");
  };

  const toggleAuto = () => {
    const cfg = engine.getSnapshot().config;
    // Reconfigure path preserves account when only toggling auto.
    const next = { ...cfg, autoPaperTrading: !cfg.autoPaperTrading, autoMinStrength: Number(autoMin) || 75 };
    // Bypass freshness rule for the auto toggle: rebuild snapshot config in place.
    const s = engine.getSnapshot();
    (s as { config: typeof cfg }).config = next;
    engine.touch(marks);
    setSnap({ ...engine.getSnapshot() });
  };

  const selected = open.find((p) => p.id === selectedId) ?? open[0] ?? null;

  const handleReset = async () => {
    engine.reset({
      ...snap.config,
      startingBalance: Number(balanceInput) || 1000,
      riskPerTrade: (Number(riskInput) || 1) / 100,
    });
    autoTaken.clear();
    setConfirmReset(false);
    // Keep cloud consistent: clear remote positions/trades so a reset does not
    // resurrect stale rows on the next login. Best-effort; local already reset.
    try {
      const sb = getSupabase();
      const accId = cloud.account?.id;
      if (sb && user && accId) {
        await sb.from("paper_positions").delete().eq("account_id", accId);
        await sb.from("paper_trades").delete().eq("account_id", accId);
        try {
          localStorage?.removeItem(`cryptoin:paper-migrated:${user.id}`);
        } catch { /* ignore */ }
      }
    } catch { /* local reset already succeeded */ }
  };

  const handleMigrate = async () => {
    setMigrating(true);
    try {
      await cloud.migrate();
    } finally {
      setMigrating(false);
    }
  };

  return (
    <div>
      <PageHeader
        title="Paper Trading"
        description="Simulated positions on live marks. No exchange orders exist in this app."
        right={
          <>
            <CloudSyncBadge status={cloud.status} />
            <ConnectionBadge showLabel={false} />
          </>
        }
      />
      <p className="mb-4 rounded-2xl border border-emerald-400/30 bg-emerald-400/[0.07] px-5 py-3 text-[13px] font-bold tracking-wide text-emerald-200">
        {SAFETY}
      </p>

      <div className="mb-4">
        <AuthPanel
          syncStatus={cloud.status}
          needsMigration={cloud.needsMigration}
          migrated={cloud.migrated}
          lastError={cloud.lastError}
          onMigrate={() => void handleMigrate()}
          migrating={migrating}
        />
        {cloud.status === "error" && (
          <button
            onClick={cloud.retry}
            className="mt-2 rounded-xl border border-slate-700 px-3 py-1.5 text-xs font-bold text-slate-300 hover:bg-slate-800"
          >
            Retry sync
          </button>
        )}
      </div>

      {cloudLoading ? (
        <div role="status" aria-label="Loading paper account" className="rounded-2xl border border-slate-800 bg-slate-900/70 px-5 py-12 text-center">
          <p className="animate-pulse text-sm font-bold text-slate-200">🟡 Loading cloud account…</p>
          <p className="mx-auto mt-1 max-w-md text-xs text-slate-500">
            Fetching your paper account from Supabase. A local default is never shown as your balance.
          </p>
        </div>
      ) : (
        <>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Starting Balance" value={`$${snap.config.startingBalance.toLocaleString()}`} />
        <Stat label="Current Equity" value={`$${equity.toFixed(2)}`} tone={equity >= snap.config.startingBalance ? "up" : "down"} />
        <Stat label="Realized PnL" value={`${snap.realizedPnl >= 0 ? "+" : ""}$${snap.realizedPnl.toFixed(2)}`} tone={snap.realizedPnl >= 0 ? "up" : "down"} />
        <Stat label="Total PnL" value={`${totalPnl >= 0 ? "+" : ""}$${totalPnl.toFixed(2)}`} tone={totalPnl >= 0 ? "up" : "down"} />
        <Stat label="Win Rate" value={`${winRate.toFixed(1)}%`} sub={`${snap.wins}/${snap.closedCount}`} />
        <Stat label="Avg R / PF" value={`${avgR.toFixed(2)}R / ${profitFactor === Infinity ? "∞" : profitFactor.toFixed(2)}`} />
        <Stat label="Max Drawdown" value={`${snap.maxDrawdownPct.toFixed(2)}%`} />
        <Stat label="TP1/2/3 %" value={`${tpRate(1)} / ${tpRate(2)} / ${tpRate(3)}`} />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader title="Paper Account" subtitle="Config editable only on a fresh account" />
          <div className="space-y-2.5 p-5 text-sm">
            <label className="block">
              <span className="mb-1 block text-[11px] font-bold tracking-widest text-slate-500 uppercase">Starting balance $</span>
              <input value={balanceInput} disabled={!fresh} onChange={(e) => setBalanceInput(e.target.value.replace(/[^0-9.]/g, ""))} className="w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 font-mono text-white disabled:opacity-50" />
            </label>
            <label className="block">
              <span className="mb-1 block text-[11px] font-bold tracking-widest text-slate-500 uppercase">Risk per trade % (default 1)</span>
              <input value={riskInput} disabled={!fresh} onChange={(e) => setRiskInput(e.target.value.replace(/[^0-9.]/g, ""))} className="w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 font-mono text-white disabled:opacity-50" />
            </label>
            <label className="block">
              <span className="mb-1 block text-[11px] font-bold tracking-widest text-slate-500 uppercase">Auto min strength</span>
              <input value={autoMin} onChange={(e) => setAutoMin(e.target.value.replace(/[^0-9.]/g, ""))} className="w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 font-mono text-white" />
            </label>
            <div className="flex flex-wrap gap-2 pt-1">
              <button onClick={applyConfig} disabled={!fresh} className="rounded-xl border border-slate-700 px-3 py-2 text-xs font-bold text-slate-200 disabled:opacity-40 hover:bg-slate-800">
                Apply config
              </button>
              <button onClick={toggleAuto} className={cn("rounded-xl border px-3 py-2 text-xs font-bold", snap.config.autoPaperTrading ? "border-cyan-400/50 bg-cyan-400/10 text-cyan-200" : "border-slate-700 text-slate-300 hover:bg-slate-800")}>
                AUTO PAPER TRADING: {snap.config.autoPaperTrading ? "ON (sim only)" : "OFF"}
              </button>
              {!confirmReset ? (
                <button onClick={() => setConfirmReset(true)} className="rounded-xl border border-rose-400/40 px-3 py-2 text-xs font-bold text-rose-300">
                  RESET PAPER ACCOUNT
                </button>
              ) : (
                <span className="inline-flex gap-2">
                  <button
                    onClick={() => void handleReset()}
                    className="rounded-xl bg-rose-500 px-3 py-2 text-xs font-bold text-white"
                  >
                    Confirm reset
                  </button>
                  <button onClick={() => setConfirmReset(false)} className="rounded-xl border border-slate-700 px-3 py-2 text-xs font-bold text-slate-300">
                    Cancel
                  </button>
                </span>
              )}
            </div>
            {!fresh && <p className="text-[11px] text-slate-600">Balance/risk lock once the account has activity — reset (keeps no strategy config; there is none stored) to change them.</p>}
          </div>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader title={`Open Positions · ${open.length}`} subtitle="Live marks drive TP/SL progression" />
          {open.length === 0 ? (
            <p className="px-5 py-8 text-center text-sm text-slate-500">No open simulated positions. Take one from a coin page or enable auto paper trading.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-left text-xs" style={{ minWidth: 760 }}>
                <thead>
                  <tr className="border-b border-slate-800 text-[10px] tracking-widest text-slate-500 uppercase">
                    {["Coin", "Dir", "Entry", "Current", "SL", "TP1/2/3", "PnL", "R", ""].map((c) => (
                      <th key={c} className="px-3 py-2.5 font-semibold whitespace-nowrap">{c}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {open.map((p) => {
                    const mark = marks.get(p.symbol) ?? NaN;
                    const unreal = unrealizedFor(p, mark);
                    const r = p.risk > 0 ? unreal / p.risk : 0;
                    return (
                      <tr key={p.id} className={cn("border-b border-slate-800/50 font-mono last:border-0 hover:bg-slate-900/50", selected?.id === p.id && "bg-slate-900/70")}>
                        <td className="px-3 py-2"><button onClick={() => setSelectedId(p.id)} className="font-bold text-white hover:text-cyan-300">{p.symbol}</button><span className="ml-1 text-[10px] text-slate-500">{p.status}</span></td>
                        <td className={cn("px-3 py-2 font-bold", p.direction === "LONG" ? "text-emerald-300" : "text-rose-300")}>{p.direction}</td>
                        <td className="px-3 py-2 text-slate-300">{fmt(p.entry)}</td>
                        <td className="px-3 py-2 text-slate-100">{fmt(mark)}</td>
                        <td className="px-3 py-2 text-slate-300">{fmt(p.invalidation)}</td>
                        <td className="px-3 py-2 text-slate-300">{fmt(p.tp1)}/{fmt(p.tp2)}/{fmt(p.tp3)}</td>
                        <td className={cn("px-3 py-2 font-bold", unreal >= 0 ? "text-emerald-300" : "text-rose-300")}>{unreal >= 0 ? "+" : ""}{unreal.toFixed(2)}</td>
                        <td className="px-3 py-2 text-slate-200">{r.toFixed(2)}</td>
                        <td className="px-3 py-2">
                          <button onClick={() => engine.close(p.id, mark, "Manual close from dashboard.")} className="rounded-lg border border-slate-700 px-2 py-1 font-sans text-[11px] font-bold text-slate-300 hover:bg-slate-800">
                            Close
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      {selected && (
        <PositionChart position={selected} mark={marks.get(selected.symbol) ?? NaN} />
      )}

      <Card className="mt-4">
        <CardHeader
          title={`Trade History · ${closed.length}`}
          subtitle="Simulated fills only"
          right={
            <select value={coinFilter} onChange={(e) => setCoinFilter(e.target.value)} className="rounded-lg border border-slate-800 bg-slate-950 px-2 py-1.5 text-xs font-bold text-slate-300">
              {coins.map((c) => (
                <option key={c} value={c}>{c === "ALL" ? "All coins" : c}</option>
              ))}
            </select>
          }
        />
        {history.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-slate-500">No closed simulated trades yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-xs" style={{ minWidth: 860 }}>
              <thead>
                <tr className="border-b border-slate-800 text-[10px] tracking-widest text-slate-500 uppercase">
                  {["Date", "Coin", "Dir", "Entry", "Exit", "Result", "PnL", "R", "Duration"].map((c) => (
                    <th key={c} className="px-3 py-2.5 font-semibold whitespace-nowrap">{c}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {history.map((p) => (
                  <tr key={p.id} className="border-b border-slate-800/50 font-mono last:border-0 hover:bg-slate-900/50">
                    <td className="px-3 py-2 whitespace-nowrap text-slate-400">{new Date(p.openedAt).toLocaleString()}</td>
                    <td className="px-3 py-2 font-bold text-white">{p.symbol}</td>
                    <td className={cn("px-3 py-2 font-bold", p.direction === "LONG" ? "text-emerald-300" : "text-rose-300")}>{p.direction}</td>
                    <td className="px-3 py-2 text-slate-300">{fmt(p.entry)}</td>
                    <td className="px-3 py-2 text-slate-300">{p.closeReason ?? p.status}</td>
                    <td className="px-3 py-2 text-slate-300">{p.status}</td>
                    <td className={cn("px-3 py-2 font-bold", p.realized - p.fees >= 0 ? "text-emerald-300" : "text-rose-300")}>
                      {(p.realized - p.fees >= 0 ? "+" : "") + (p.realized - p.fees).toFixed(2)}
                    </td>
                    <td className="px-3 py-2 text-slate-200">{realizedR(p).toFixed(2)}</td>
                    <td className="px-3 py-2 text-slate-400">{p.closedAt ? formatMs(p.closedAt - p.openedAt) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
        </>
      )}
    </div>
  );
}

function PositionChart({ position: p, mark }: { position: PaperPosition; mark: number }) {
  const { candles: data } = useCandles(p.symbol, (["5m", "15m", "1h", "4h"].includes(p.timeframe) ? p.timeframe : "15m") as Timeframe);
  const levels: ChartLevel[] = [
    { price: p.entry, label: "Entry", color: "#22d3ee", dashed: false },
    { price: p.invalidation, label: "SL", color: "#fb7185" },
    { price: p.tp1, label: "TP1", color: "#34d399" },
    { price: p.tp2, label: "TP2", color: "#34d399" },
    { price: p.tp3, label: "TP3", color: "#34d399" },
  ];
  if (Number.isFinite(mark) && mark > 0) levels.push({ price: mark, label: "Now", color: "#e2e8f0", dashed: false });
  return (
    <Card className="mt-4">
      <CardHeader title={`Position Chart · ${p.symbol} ${p.direction}`} subtitle="Entry / SL / TPs over live candles (simulated)" />
      <div className="p-2">
        <CandleChart candles={data} levels={levels} />
      </div>
    </Card>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "up" | "down" }) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
      <p className="text-[11px] font-semibold tracking-widest text-slate-500 uppercase">{label}</p>
      <p className={cn("mt-1 font-mono text-lg font-bold", tone === "up" ? "text-emerald-300" : tone === "down" ? "text-rose-300" : "text-white")}>{value}</p>
      {sub ? <p className="mt-0.5 text-xs text-slate-500">{sub}</p> : null}
    </div>
  );
}

function formatMs(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  if (h < 1) return `${Math.max(1, Math.round(ms / 60_000))}m`;
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
