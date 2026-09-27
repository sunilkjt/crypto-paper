import { useEffect, useState } from "react";
import { cn } from "../lib/cn";
import {
  CONNECTION_META,
  formatLastUpdate,
} from "../market/connection";
import { useMarkets } from "../market/store";

/**
 * Real connection badge: 🟢 Online / 🟡 Connecting…/Reconnecting… /
 * 🟠 Degraded/Rate limited / 🔴 Offline, plus "Last update: X seconds ago"
 * (and a retry countdown while rate limited — no stack traces for users).
 * Driven by received data — never by page load. Refreshes its own label
 * on a 5s timer so the provider subtree is not re-rendered every second.
 */
export function ConnectionBadge({ showLabel = true }: { showLabel?: boolean }) {
  const { connection, lastSuccessAt, rateLimitedAt } = useMarkets();
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 5000);
    return () => window.clearInterval(id);
  }, []);

  const meta = CONNECTION_META[connection];
  const retryIn =
    connection === "RATE_LIMITED" && rateLimitedAt > 0
      ? Math.max(1, Math.ceil((12_000 - (now - rateLimitedAt)) / 1000))
      : 0;
  return (
    <span
      className="inline-flex items-center gap-2 rounded-full border border-slate-800 bg-slate-900 px-3 py-1 text-[11px] font-bold text-slate-300"
      title={formatLastUpdate(lastSuccessAt, now)}
    >
      <span className={cn("h-1.5 w-1.5 rounded-full", meta.dot)} />
      <span aria-hidden="true">{meta.emoji}</span>
      {showLabel ? meta.label : null}
      {retryIn > 0 && (
        <span className="font-mono text-[10px] text-slate-500">· retry {retryIn}s</span>
      )}
    </span>
  );
}

export function ConnectionLine() {
  const { connection, lastSuccessAt } = useMarkets();
  const [, setNow] = useState(Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 5000);
    return () => window.clearInterval(id);
  }, []);

  const meta = CONNECTION_META[connection];
  return (
    <span className="text-[11px] text-slate-500">
      {meta.emoji} {meta.label} · {formatLastUpdate(lastSuccessAt)}
    </span>
  );
}


