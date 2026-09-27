import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Card, CardHeader, PageHeader } from "../components/ui";
import { ConnectionBadge } from "../components/ConnectionBadge";
import { useMarkets } from "../market/store";
import { useScan } from "../scanner";
import { addWatched, loadWatchlist, removeWatched } from "../alerts";
import { formatPriceUsd } from "../lib/format";

/**
 * Watchlist: user-pinned coins. The monitor flags their events and can
 * restrict alerts to them; the global scanner is unaffected.
 */
export default function Watchlist() {
  const [list, setList] = useState<string[]>(() => loadWatchlist());
  const [draft, setDraft] = useState("");
  const { markets } = useMarkets();
  const { summary } = useScan();

  useEffect(() => {
    setList(loadWatchlist());
  }, []);

  const prices = useMemo(() => new Map(markets.map((m) => [m.symbol, m.markPrice])), [markets]);
  const scored = useMemo(() => new Map((summary?.results ?? []).map((r) => [r.symbol, r])), [summary]);
  const known = useMemo(() => new Set(markets.map((m) => m.symbol)), [markets]);

  const add = (symbol: string) => {
    const coin = symbol.toUpperCase().trim().replace(/[^A-Z0-9:]/g, "");
    if (!coin) return;
    setList(addWatched(coin));
    setDraft("");
  };

  return (
    <div>
      <PageHeader
        title="Watchlist"
        description="Pin coins for prioritized alerts. The global scanner keeps scoring everything."
        right={<ConnectionBadge showLabel={false} />}
      />

      <Card>
        <CardHeader title={`Watched Coins · ${list.length}`} subtitle="Alerts flag watched coins ★ and can filter to them in Settings" />
        <div className="flex flex-wrap gap-2 border-b border-slate-800/70 px-4 py-3">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value.toUpperCase())}
            onKeyDown={(e) => {
              if (e.key === "Enter") add(draft);
            }}
            placeholder="Add coin: OP, XPL…"
            className="min-w-[200px] flex-1 rounded-xl border border-slate-800 bg-slate-950 px-3 py-2 text-sm font-bold text-slate-100 placeholder:text-slate-600 focus:border-cyan-400/60 focus:outline-none sm:max-w-xs sm:flex-none"
          />
          <button onClick={() => add(draft)} className="rounded-xl bg-cyan-500 px-4 py-2 text-sm font-bold text-slate-950 hover:bg-cyan-400">
            Add
          </button>
        </div>
        {list.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-slate-500">
            Nothing watched yet — e.g. BTC, ETH, OP. Watched coins surface first in alerts.
          </p>
        ) : (
          <ul className="divide-y divide-slate-800/60">
            {list.map((symbol) => {
              const r = scored.get(symbol);
              return (
                <li key={symbol} className="flex items-center gap-3 px-5 py-3">
                  <Link to={`/coin/${symbol}`} className="text-sm font-extrabold text-white hover:text-cyan-300">
                    {symbol}
                  </Link>
                  {!known.has(symbol) && (
                    <span className="rounded bg-amber-400/10 px-2 py-0.5 text-[10px] font-bold text-amber-300">
                      NOT ON HYPERLIQUID
                    </span>
                  )}
                  <span className="font-mono text-xs text-slate-400">{formatPriceUsd(prices.get(symbol) ?? null, symbol)}</span>
                  {r && r.signal.direction !== "WAIT" ? (
                    <span className="font-mono text-xs text-slate-300">
                      {r.signal.direction} {r.signal.signalStrength} · {r.setupType}
                    </span>
                  ) : (
                    <span className="text-xs text-slate-600">{r ? "WAIT — no setup" : "awaiting scan"}</span>
                  )}
                  <button
                    onClick={() => setList(removeWatched(symbol))}
                    className="ml-auto rounded-lg border border-slate-800 px-2.5 py-1 text-[11px] font-bold text-slate-400 hover:border-rose-400/40 hover:text-rose-300"
                  >
                    Remove
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}
