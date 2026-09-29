import { useEffect, useState } from "react";
import { readDiagnostics, type DiagnosticsSnapshot } from "../market/diagnostics";
import { aiQueueDepth } from "../ai/ratelimit";
import { readAiStats } from "../ai/stats";

/**
 * Development-only request monitor. Rendered behind `import.meta.env.DEV`
 * so production users never see it. Refreshes every 2s from the shared
 * counters (REST/min, sockets, cache hits/misses, 429s, subscriptions).
 */
export function DiagnosticsPanel() {
  const [snap, setSnap] = useState<DiagnosticsSnapshot>(() => readDiagnostics());
  const [ai, setAi] = useState(() => readAiStats());
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const id = window.setInterval(() => {
      setSnap(readDiagnostics());
      setAi(readAiStats());
    }, 2000);
    return () => window.clearInterval(id);
  }, [open]);

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="rounded-lg border border-dashed border-slate-700 px-3 py-1.5 font-mono text-[11px] text-slate-500 hover:border-slate-500"
      >
        Hyperliquid requests (dev)
      </button>
    );
  }

  const rows: [string, string | number][] = [
    ["REST requests/min", snap.restPerMinute],
    ["REST total", snap.restRequests],
    ["WebSocket connections", `${snap.wsConnections} (peak ${snap.wsPeakConnections})`],
    ["Cache hits", snap.cacheHits],
    ["Cache misses", snap.cacheMisses],
    ["Cache hit rate", `${snap.cacheHitRate}%`],
    ["Rate limits (429)", snap.rateLimits],
    ["Active subscriptions", snap.activeSubscriptions],
    ["AI requests (backend calls)", ai.calls],
    ["AI cache hits", ai.hits],
    ["AI cache misses", ai.misses],
    ["AI queued/in-flight", aiQueueDepth()],
  ];

  return (
    <div className="rounded-xl border border-dashed border-slate-700 p-3">
      <div className="mb-2 flex items-center justify-between">
        <p className="font-mono text-[11px] font-bold tracking-widest text-slate-400 uppercase">
          Hyperliquid requests (dev only)
        </p>
        <button
          onClick={() => setOpen(false)}
          className="rounded-lg border border-slate-800 px-2 py-0.5 font-mono text-[11px] text-slate-500"
        >
          Hide
        </button>
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-[11px]">
        {rows.map(([k, v]) => (
          <div key={k} className="flex items-center justify-between border-b border-dashed border-slate-800/60 py-0.5">
            <dt className="text-slate-500">{k}</dt>
            <dd className="text-slate-200">{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export function isDevDiagnosticsEnabled(): boolean {
  try {
    return (import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV === true;
  } catch {
    return false;
  }
}
