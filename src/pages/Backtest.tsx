import { useMemo, useRef, useState } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Card, CardHeader, PageHeader } from "../components/ui";
import { ConnectionBadge } from "../components/ConnectionBadge";
import { useMarkets } from "../market/store";
import { classifyMarket } from "../market/classify";
import {
  DEFAULT_BACKTEST_CONFIG,
  runBacktest,
  type BacktestConfig,
  type BacktestProgress,
  type BacktestResult,
} from "../backtest";
import type { Timeframe } from "../market/hyperliquid/types";
import { cn } from "../lib/cn";

const DAY = 86_400_000;
const FALLBACK_SYMBOLS = ["BTC", "ETH", "OP", "SOL"];

function toInputValue(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export default function Backtest() {
  const now = useMemo(() => Date.now(), []);
  const [symbol, setSymbol] = useState("OP");
  const [compare, setCompare] = useState<string[]>([]);
  const [timeframe, setTimeframe] = useState<Timeframe>("15m");
  const [start, setStart] = useState(toInputValue(now - 30 * DAY));
  const [end, setEnd] = useState(toInputValue(now));
  const [balance, setBalance] = useState("500");
  const [riskPct, setRiskPct] = useState("1");
  const [feeBps, setFeeBps] = useState("5");
  const [slipBps, setSlipBps] = useState("5");
  const [leverage, setLeverage] = useState("1");
  const [minStrength, setMinStrength] = useState("60");
  const [trainSplit, setTrainSplit] = useState("100");
  const [walkForward, setWalkForward] = useState(false);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<BacktestProgress | null>(null);
  const [results, setResults] = useState<BacktestResult[]>([]);
  const [selected, setSelected] = useState(0);
  const [tradeSort, setTradeSort] = useState<"date" | "r" | "pnl">("date");
  const [tradeFilter, setTradeFilter] = useState("ALL");
  const abortRef = useRef(false);

  // Preset chips derived from the live discovered universe — never a
  // hardcoded stock/commodity list. Falls back to majors before load.
  const { markets } = useMarkets();
  const presets = useMemo(() => {
    if (markets.length === 0) return { crypto: FALLBACK_SYMBOLS, stocks: [] as string[], commodities: [] as string[] };
    const main = new Set(markets.filter((m) => !m.symbol.includes(":")).map((m) => m.symbol.toUpperCase()));
    const byVol = [...markets].sort((a, b) => (b.dayVolumeNotional ?? 0) - (a.dayVolumeNotional ?? 0));
    const pick = (cls: "crypto" | "stocks" | "commodities", n: number) =>
      byVol.filter((m) => classifyMarket(m.symbol, main) === cls).slice(0, n).map((m) => m.symbol);
    return { crypto: pick("crypto", 4), stocks: pick("stocks", 4), commodities: pick("commodities", 4) };
  }, [markets]);
  const comparePool = useMemo(
    () => [...presets.crypto, ...presets.stocks, ...presets.commodities].filter((s) => s !== symbol.toUpperCase()).slice(0, 8),
    [presets, symbol],
  );

  const symbols = useMemo(
    () => [symbol.toUpperCase(), ...compare.map((s) => s.toUpperCase()).filter((s) => s !== symbol.toUpperCase())].slice(0, 4),
    [symbol, compare],
  );

  const run = async () => {
    const startTs = new Date(`${start}T00:00:00Z`).getTime();
    const endTs = new Date(`${end}T23:59:59Z`).getTime();
    const base: BacktestConfig = {
      ...DEFAULT_BACKTEST_CONFIG,
      timeframe,
      startDate: startTs,
      endDate: Math.min(endTs, Date.now()),
      startingBalance: Number(balance) || 500,
      riskPerTrade: (Number(riskPct) || 1) / 100,
      feeRate: (Number(feeBps) || 0) / 10_000,
      slippageRate: (Number(slipBps) || 0) / 10_000,
      leverage: Math.min(50, Math.max(1, Number(leverage) || 1)),
      minStrength: Number(minStrength) || 0,
      trainFraction: Number(trainSplit) / 100,
      walkTrainMs: walkForward ? 30 * DAY : 0,
      walkTestMs: walkForward ? 7 * DAY : 0,
    };
    abortRef.current = false;
    setRunning(true);
    setResults([]);
    setSelected(0);
    const out: BacktestResult[] = [];
    try {
      for (let i = 0; i < symbols.length; i++) {
        if (abortRef.current) break;
        const res = await runBacktest({ ...base, symbol: symbols[i] }, (p) =>
          setProgress({ ...p, note: `[${symbols[i]}] ${p.note}` }),
        );
        out.push(res);
        setResults([...out]);
        setProgress({ stage: "done", done: i + 1, total: symbols.length, note: `${symbols[i]} complete: ${res.trades.length} trades.` });
      }
    } catch (err) {
      setProgress({
        stage: "done",
        done: out.length,
        total: symbols.length,
        note: err instanceof Error ? err.message : "Backtest failed.",
      });
    } finally {
      setRunning(false);
    }
  };

  const active = results[Math.min(selected, results.length - 1)] ?? null;
  const trades = useMemo(() => {
    if (!active) return [];
    let list = active.trades;
    if (tradeFilter !== "ALL") {
      list = list.filter((t) =>
        tradeFilter === "IN-SAMPLE" || tradeFilter === "OUT-OF-SAMPLE"
          ? (tradeFilter === "IN-SAMPLE") === t.inSample
          : t.result === tradeFilter || t.setupType === tradeFilter,
      );
    }
    const sorted = [...list];
    if (tradeSort === "r") sorted.sort((a, b) => b.rMultiple - a.rMultiple);
    else if (tradeSort === "pnl") sorted.sort((a, b) => b.pnl - a.pnl);
    else sorted.sort((a, b) => a.signalTimestamp - b.signalTimestamp);
    return sorted;
  }, [active, tradeFilter, tradeSort]);

  return (
    <div>
      <PageHeader
        title="Backtest"
        description="Replay historical candles through the exact live signal engine. No future data, no repainting — past performance never implies future results."
        right={<ConnectionBadge showLabel={false} />}
      />

      <Card>
        <CardHeader title="Backtest Configuration" subtitle="Fee 5bps/side · slippage 0.05%/side defaults — shown in every result" />
        <div className="grid gap-3 p-5 sm:grid-cols-2 lg:grid-cols-4">
          <label className="block">
            <span className="mb-1 block text-[11px] font-bold tracking-widest text-slate-500 uppercase">Symbol</span>
            <div className="flex flex-wrap gap-1">
              {presets.crypto.map((s) => (
                <button key={s} onClick={() => setSymbol(s)} className={cn("rounded-lg border px-2.5 py-1.5 text-xs font-bold", symbol === s ? "border-cyan-400/50 bg-cyan-400/10 text-cyan-200" : "border-slate-800 text-slate-400")}>
                  {s}
                </button>
              ))}
              <input value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase().replace(/[^A-Z0-9:]/g, ""))} placeholder="BTC, xyz:NVDA…" className="w-28 rounded-lg border border-slate-800 bg-slate-950 px-2 py-1.5 text-xs font-bold text-white" />
            </div>
            {(presets.stocks.length > 0 || presets.commodities.length > 0) && (
              <>
                <span className="mt-2 block text-[11px] text-slate-600">Stocks:</span>
                <div className="mt-1 flex flex-wrap gap-1">
                  {presets.stocks.length === 0 ? (
                    <span className="text-[11px] text-slate-600">none discovered</span>
                  ) : (
                    presets.stocks.map((s) => (
                      <button key={s} onClick={() => setSymbol(s)} className={cn("rounded-lg border px-2 py-1 text-[11px] font-bold", symbol === s ? "border-cyan-400/50 bg-cyan-400/10 text-cyan-200" : "border-slate-800 text-slate-500")}>
                        {s}
                      </button>
                    ))
                  )}
                </div>
                <span className="mt-2 block text-[11px] text-slate-600">Commodities:</span>
                <div className="mt-1 flex flex-wrap gap-1">
                  {presets.commodities.length === 0 ? (
                    <span className="text-[11px] text-slate-600">none discovered</span>
                  ) : (
                    presets.commodities.map((s) => (
                      <button key={s} onClick={() => setSymbol(s)} className={cn("rounded-lg border px-2 py-1 text-[11px] font-bold", symbol === s ? "border-cyan-400/50 bg-cyan-400/10 text-cyan-200" : "border-slate-800 text-slate-500")}>
                        {s}
                      </button>
                    ))
                  )}
                </div>
              </>
            )}
            <span className="mt-1 block text-[11px] text-slate-600">Compare:</span>
            <div className="mt-1 flex flex-wrap gap-1">
              {comparePool.filter((s) => s !== symbol).map((s) => (
                <button
                  key={s}
                  onClick={() => setCompare((c) => (c.includes(s) ? c.filter((x) => x !== s) : [...c, s].slice(0, 3)))}
                  className={cn("rounded-lg border px-2 py-1 text-[11px] font-bold", compare.includes(s) ? "border-cyan-400/50 bg-cyan-400/10 text-cyan-200" : "border-slate-800 text-slate-500")}
                >
                  {compare.includes(s) ? `✓ ${s}` : `+ ${s}`}
                </button>
              ))}
            </div>
          </label>
          <div>
            <span className="mb-1 block text-[11px] font-bold tracking-widest text-slate-500 uppercase">Timeframe</span>
            <div className="flex flex-wrap gap-1">
              {(["1m", "5m", "15m", "1h", "4h"] as Timeframe[]).map((t) => (
                <button key={t} onClick={() => setTimeframe(t)} className={cn("rounded-lg border px-2.5 py-1.5 text-xs font-bold", timeframe === t ? "border-cyan-400/50 bg-cyan-400/10 text-cyan-200" : "border-slate-800 text-slate-400")}>
                  {t}
                </button>
              ))}
            </div>
          </div>
          <label className="block">
            <span className="mb-1 block text-[11px] font-bold tracking-widest text-slate-500 uppercase">Start / End</span>
            <div className="flex gap-1">
              <input type="date" value={start} onChange={(e) => setStart(e.target.value)} className="w-full rounded-lg border border-slate-800 bg-slate-950 px-2 py-1.5 text-xs text-slate-200" />
              <input type="date" value={end} onChange={(e) => setEnd(e.target.value)} className="w-full rounded-lg border border-slate-800 bg-slate-950 px-2 py-1.5 text-xs text-slate-200" />
            </div>
          </label>
          <div className="grid grid-cols-2 gap-2">
            <Num label="Balance $" value={balance} set={setBalance} />
            <Num label="Risk %" value={riskPct} set={setRiskPct} />
            <Num label="Fee bps" value={feeBps} set={setFeeBps} />
            <Num label="Slip bps" value={slipBps} set={setSlipBps} />
            <Num label="Leverage" value={leverage} set={setLeverage} />
            <Num label="Min str" value={minStrength} set={setMinStrength} />
          </div>
          <div>
            <span className="mb-1 block text-[11px] font-bold tracking-widest text-slate-500 uppercase">Train / Test split</span>
            <div className="flex gap-1">
              {["100", "80", "70"].map((v) => (
                <button key={v} onClick={() => setTrainSplit(v)} className={cn("rounded-lg border px-2.5 py-1.5 text-xs font-bold", trainSplit === v ? "border-cyan-400/50 bg-cyan-400/10 text-cyan-200" : "border-slate-800 text-slate-400")}>
                  {v === "100" ? "All" : `${v}/${100 - Number(v)}`}
                </button>
              ))}
            </div>
            <label className="mt-2 flex items-center gap-2 text-xs text-slate-400">
              <input type="checkbox" checked={walkForward} onChange={(e) => setWalkForward(e.target.checked)} className="accent-cyan-400" />
              Walk-forward (30d train / 7d test, rolling)
            </label>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3 border-t border-slate-800/70 px-5 py-3">
          {!running ? (
            <button onClick={() => void run()} className="rounded-xl bg-cyan-500 px-5 py-2.5 text-sm font-bold text-slate-950 hover:bg-cyan-400">
              RUN BACKTEST
            </button>
          ) : (
            <button onClick={() => { abortRef.current = true; setRunning(false); }} className="rounded-xl border border-rose-400/40 px-5 py-2.5 text-sm font-bold text-rose-300">
              STOP
            </button>
          )}
          <span className="text-xs text-slate-400">
            {running || progress ? progress ? `${progress.stage.toUpperCase()}… ${progress.note}` : "Starting…" : "Configure, then run."}
          </span>
          <span className="ml-auto text-[11px] text-slate-600">
            Leverage scales margin/exposure only — never the edge. No optimization is fitted to test data.
          </span>
        </div>
      </Card>

      {results.length > 1 && (
        <div className="mt-4 flex flex-wrap gap-2">
          {results.map((r, i) => (
            <button
              key={r.config.symbol}
              onClick={() => setSelected(i)}
              className={cn("rounded-xl border px-4 py-2 text-xs font-bold", i === selected ? "border-cyan-400/50 bg-cyan-400/10 text-cyan-200" : "border-slate-800 text-slate-400")}
            >
              {r.config.symbol} · {r.trades.length} trades · {r.metrics.netPnl >= 0 ? "+" : ""}{r.metrics.netPnl}
            </button>
          ))}
        </div>
      )}

      {active && (
        <div className="mt-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <Metric label="Total Trades" value={String(active.metrics.totalTrades)} />
            <Metric label="Win Rate" value={`${active.metrics.winRate}%`} />
            <Metric label="Net PnL" value={`${active.metrics.netPnl >= 0 ? "+" : ""}${active.metrics.netPnl}`} tone={active.metrics.netPnl >= 0 ? "up" : "down"} />
            <Metric label="Profit Factor" value={active.metrics.profitFactor === Infinity ? "∞" : String(active.metrics.profitFactor)} />
            <Metric label="Max DD" value={`${active.metrics.maxDrawdownPct}%`} />
            <Metric label="Average R" value={String(active.metrics.averageR)} />
          </div>
          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
            <Metric label="Return %" value={`${active.metrics.returnPct}%`} small />
            <Metric label="Median R" value={String(active.metrics.medianR)} small />
            <Metric label="TP1 / TP2 / TP3 %" value={`${active.metrics.tp1HitRate}/${active.metrics.tp2HitRate}/${active.metrics.tp3HitRate}`} small />
            <Metric label="Invalidation %" value={String(active.metrics.invalidationRate)} small />
            <Metric label="Avg hold" value={formatDuration(active.metrics.averageHoldingMs)} small />
            <Metric label={`Funding ${active.fundingAvailable ? "(applied)" : "(n/a)"}`} value={active.fundingAvailable ? "included" : "unavailable"} small />
          </div>

          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader title="Equity Curve" subtitle={`Balance over time · fee ${active.config.feeRate * 10000}bps · slip ${active.config.slippageRate * 10000}bps`} />
              <div className="h-[240px] p-2">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={active.equity} margin={{ left: 8, right: 16, top: 8, bottom: 8 }}>
                    <defs>
                      <linearGradient id="eqFill" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#22d3ee" stopOpacity={0.35} />
                        <stop offset="100%" stopColor="#22d3ee" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="timestamp" tickFormatter={(t: number) => (t > 0 ? new Date(t).toLocaleDateString() : "")} stroke="#475569" fontSize={10} tickLine={false} minTickGap={40} />
                    <YAxis stroke="#475569" fontSize={10} tickLine={false} width={64} domain={["auto", "auto"]} />
                    <Tooltip contentStyle={{ background: "#020617", border: "1px solid #1e293b", borderRadius: 12, fontSize: 12 }} labelFormatter={(t) => (Number(t) > 0 ? new Date(Number(t)).toLocaleString() : "start")} />
                    <Area type="monotone" dataKey="equity" stroke="#22d3ee" fill="url(#eqFill)" dot={false} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </Card>
            <Card>
              <CardHeader title="Drawdown" subtitle="Peak-to-trough % over time" />
              <div className="h-[240px] p-2">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={active.equity} margin={{ left: 8, right: 16, top: 8, bottom: 8 }}>
                    <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="timestamp" tickFormatter={(t: number) => (t > 0 ? new Date(t).toLocaleDateString() : "")} stroke="#475569" fontSize={10} tickLine={false} minTickGap={40} />
                    <YAxis stroke="#475569" fontSize={10} tickLine={false} width={48} />
                    <Tooltip contentStyle={{ background: "#020617", border: "1px solid #1e293b", borderRadius: 12, fontSize: 12 }} labelFormatter={(t) => (Number(t) > 0 ? new Date(Number(t)).toLocaleString() : "start")} />
                    <Area type="monotone" dataKey="drawdownPct" stroke="#fb7185" fill="#fb7185" fillOpacity={0.25} dot={false} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </Card>
          </div>

          <div className="mt-4 grid gap-4 lg:grid-cols-3">
            <BreakdownCard title="Performance by Signal Strength" rows={active.byStrength} />
            <BreakdownCard title="Performance by Setup" rows={active.bySetup} />
            <BreakdownCard title="Performance by Direction" rows={active.byDirection} />
          </div>

          <Card className="mt-4">
            <CardHeader
              title={`Trade History · ${active.trades.length}`}
              subtitle="Click headers to sort · filter by result or setup"
              right={
                <div className="flex gap-1">
                  {(["date", "r", "pnl"] as const).map((s) => (
                    <button key={s} onClick={() => setTradeSort(s)} className={cn("rounded-lg border px-2 py-1 text-[11px] font-bold", tradeSort === s ? "border-cyan-400/50 text-cyan-200" : "border-slate-800 text-slate-500")}>
                      {s === "date" ? "Date" : s === "r" ? "R" : "PnL"}
                    </button>
                  ))}
                  <select value={tradeFilter} onChange={(e) => setTradeFilter(e.target.value)} className="rounded-lg border border-slate-800 bg-slate-950 px-2 py-1 text-[11px] font-bold text-slate-300">
                    {["ALL", "IN-SAMPLE", "OUT-OF-SAMPLE", "TP1", "TP2", "TP3", "STOPPED", "EXPIRED", "BOUNCE", "BREAKOUT", "BREAKDOWN", "PULLBACK", "REVERSAL", "TREND"].map((f) => (
                      <option key={f} value={f}>{f}</option>
                    ))}
                  </select>
                </div>
              }
            />
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-left text-xs" style={{ minWidth: 1100 }}>
                <thead>
                  <tr className="border-b border-slate-800 text-[10px] tracking-widest text-slate-500 uppercase">
                    {["#", "Date", "Dir", "Entry", "Invalidation", "TP1/2/3", "Exit", "Result", "R", "PnL", "Duration", "Strength"].map((c) => (
                      <th key={c} className="px-3 py-2.5 font-semibold whitespace-nowrap">{c}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {trades.slice(0, 200).map((t) => (
                    <tr key={t.index} className="border-b border-slate-800/50 font-mono last:border-0 hover:bg-slate-900/50">
                      <td className="px-3 py-2 text-slate-500">{t.index}</td>
                      <td className="px-3 py-2 whitespace-nowrap text-slate-400">{new Date(t.signalTimestamp).toLocaleString()}</td>
                      <td className={cn("px-3 py-2 font-bold", t.direction === "LONG" ? "text-emerald-300" : "text-rose-300")}>{t.direction}</td>
                      <td className="px-3 py-2 text-slate-300">{t.entry}</td>
                      <td className="px-3 py-2 text-slate-300">{t.invalidation}</td>
                      <td className="px-3 py-2 text-slate-300">{t.tp1}/{t.tp2}/{t.tp3}</td>
                      <td className="px-3 py-2 text-slate-300">{t.exit}</td>
                      <td className="px-3 py-2">
                        <span className={cn("rounded px-1.5 py-0.5 font-bold", t.result === "STOPPED" ? "bg-rose-400/10 text-rose-300" : t.result === "EXPIRED" ? "bg-slate-800 text-slate-400" : "bg-emerald-400/10 text-emerald-300")}>
                          {t.result}
                        </span>
                        {!t.inSample && <span className="ml-1 rounded bg-violet-400/10 px-1.5 py-0.5 text-[10px] font-bold text-violet-300">OOS</span>}
                      </td>
                      <td className={cn("px-3 py-2 font-bold", t.rMultiple > 0 ? "text-emerald-300" : "text-rose-300")}>{t.rMultiple}</td>
                      <td className={cn("px-3 py-2", t.pnl >= 0 ? "text-emerald-300" : "text-rose-300")}>{t.pnl >= 0 ? "+" : ""}{t.pnl}</td>
                      <td className="px-3 py-2 text-slate-400">{formatDuration(t.durationMs)}</td>
                      <td className="px-3 py-2 text-slate-200">{t.strength}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="border-t border-slate-800/70 px-5 py-3 text-[11px] leading-relaxed text-slate-600">
              Same-candle rule: a bar touching both stop and target exits the stop first (conservative).
              Entry fills at the next bar open + slippage. {active.candlesUsed} candles replayed; signals use
              strictly historical prefixes (trailing 400-bar window, higher TFs resampled without future data).
              Past performance never implies future results.
            </p>
          </Card>
        </div>
      )}
    </div>
  );
}

function Num({ label, value, set }: { label: string; value: string; set: (v: string) => void }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-bold tracking-widest text-slate-500 uppercase">{label}</span>
      <input value={value} onChange={(e) => set(e.target.value.replace(/[^0-9.]/g, ""))} inputMode="decimal" className="w-full rounded-lg border border-slate-800 bg-slate-950 px-2 py-1.5 text-xs font-mono text-white" />
    </label>
  );
}

function Metric({ label, value, tone, small = false }: { label: string; value: string; tone?: "up" | "down"; small?: boolean }) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
      <p className="text-[11px] font-semibold tracking-widest text-slate-500 uppercase">{label}</p>
      <p className={cn(small ? "mt-1 text-sm" : "mt-1.5 text-lg", "font-bold", tone === "up" ? "text-emerald-300" : tone === "down" ? "text-rose-300" : "text-white")}>{value}</p>
    </div>
  );
}

function BreakdownCard({ title, rows }: { title: string; rows: { band: string; trades: number; wins: number; averageR: number }[] }) {
  return (
    <Card>
      <CardHeader title={title} subtitle="Trades · wins · avg R (not a guarantee)" />
      <div className="space-y-1.5 p-4 text-xs">
        {rows.map((r) => (
          <div key={r.band} className="flex items-center justify-between rounded-lg border border-slate-800/60 px-3 py-1.5">
            <span className="font-mono font-bold text-slate-300">{r.band}</span>
            <span className="font-mono text-slate-500">{r.trades}t · {r.wins}w</span>
            <span className={cn("font-mono font-bold", r.averageR > 0 ? "text-emerald-300" : r.averageR < 0 ? "text-rose-300" : "text-slate-400")}>
              {r.trades > 0 ? `${r.averageR}R` : "—"}
            </span>
          </div>
        ))}
      </div>
    </Card>
  );
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  const h = Math.floor(ms / 3_600_000);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return d === 1 ? "1d" : `${d}d`;
}
