import { cn } from "../lib/cn";
import type { MarketStatus } from "../market/hyperliquid/types";
import { formatLastUpdated } from "../market/freshness";

export function LiveBadge({ status }: { status: MarketStatus }) {
  if (status === "loading") {
    return (
      <span className="inline-flex items-center gap-2 rounded-full border border-slate-800 bg-slate-950 px-3 py-1 text-[11px] font-bold text-slate-400">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-slate-500" />
        LOADING
      </span>
    );
  }
  if (status === "error") {
    return (
      <span className="inline-flex items-center gap-2 rounded-full border border-rose-400/30 bg-rose-400/10 px-3 py-1 text-[11px] font-bold text-rose-300">
        <span className="h-1.5 w-1.5 rounded-full bg-rose-400" />
        ERROR
      </span>
    );
  }
  if (status === "stale") {
    return (
      <span className="inline-flex items-center gap-2 rounded-full border border-amber-400/30 bg-amber-400/10 px-3 py-1 text-[11px] font-bold text-amber-300">
        <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
        DATA STALE
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-emerald-400/30 bg-emerald-400/10 px-3 py-1 text-[11px] font-bold text-emerald-300">
      <span className="relative flex h-1.5 w-1.5">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
        <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-400" />
      </span>
      LIVE
    </span>
  );
}

export function FreshnessLabel({ updatedAt }: { updatedAt: number }) {
  return (
    <span className="text-[11px] text-slate-500">{formatLastUpdated(updatedAt)}</span>
  );
}

export function StatusPill({ status }: { status: MarketStatus }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold tracking-widest",
        status === "live" && "bg-emerald-400/10 text-emerald-300",
        status === "stale" && "bg-amber-400/10 text-amber-300",
        status === "loading" && "bg-slate-800 text-slate-400",
        status === "error" && "bg-rose-400/10 text-rose-300",
      )}
    >
      {status === "live" ? "LIVE" : status === "stale" ? "DATA STALE" : status.toUpperCase()}
    </span>
  );
}
