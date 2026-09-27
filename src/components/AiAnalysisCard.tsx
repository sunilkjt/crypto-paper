import { Card, CardHeader, DemoBadge } from "./ui";
import type { AiAnalysis } from "../ai/types";

/**
 * Renders validated AI output as plain text blocks. All strings arrive
 * pre-sanitized from validateAiResponse — React text nodes escape the rest.
 * No HTML from the model is ever injected.
 */
export function AiAnalysisCard({
  state,
  analysis,
  provider,
  cached,
  marketDataTimestamp,
}: {
  state: "idle" | "loading" | "ok" | "unavailable";
  analysis: AiAnalysis | null;
  provider: string;
  cached: boolean;
  marketDataTimestamp: number;
}) {
  const providerBadge =
    provider === "local-explainer" ? (
      <DemoBadge label="LOCAL · NOT AN LLM" />
    ) : provider !== "" ? (
      <DemoBadge label={`PROVIDER: ${provider.toUpperCase()}`} />
    ) : (
      <DemoBadge label="AI" />
    );

  return (
    <Card>
      <CardHeader
        title="AI Market Analysis"
        subtitle="The engine decides — this section only explains its numbers"
        right={
          <div className="flex items-center gap-2">
            {cached && state === "ok" && <DemoBadge label="CACHED" />}
            {providerBadge}
          </div>
        }
      />
      {state === "loading" || state === "idle" ? (
        <p className="px-5 py-8 text-center text-sm text-slate-400">
          {state === "idle" ? "Waiting for a fresh deterministic signal…" : "Explaining the signal…"}
        </p>
      ) : state === "unavailable" || !analysis ? (
        <div className="px-5 py-8 text-center">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-xl border border-emerald-400/25 bg-emerald-400/[0.05] p-4">
              <p className="text-[11px] font-bold tracking-widest text-emerald-300 uppercase">Technical analysis</p>
              <p className="mt-1 text-sm font-bold text-emerald-200">AVAILABLE</p>
            </div>
            <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4">
              <p className="text-[11px] font-bold tracking-widest text-slate-500 uppercase">AI explanation</p>
              <p className="mt-1 text-sm font-bold text-amber-300">TEMPORARILY UNAVAILABLE</p>
            </div>
          </div>
          <p className="mt-3 text-xs text-slate-500">AI analysis temporarily unavailable.</p>
        </div>
      ) : (
        <div className="space-y-3 p-5">
          <Block title="Summary" text={analysis.summary} wide />
          <div className="grid gap-3 md:grid-cols-2">
            <Block title="Market Structure" text={analysis.marketStructure} />
            <Block title="Setup" text={analysis.setup} />
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <ListBlock title="Confirmations" items={analysis.confirmations} tone="emerald" />
            <ListBlock title="Conflicts" items={analysis.conflicts} tone="amber" />
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <ListBlock title="Catalysts" items={analysis.catalysts} tone="cyan" />
            <ListBlock title="Risks" items={analysis.risks} tone="rose" />
          </div>
          <Block title="Invalidation" text={analysis.invalidation} wide />
          <Block title="Conclusion" text={analysis.conclusion} wide />
          <p className="text-[11px] text-slate-600">
            AI analysis: {new Date(analysis.analysisTimestamp).toLocaleString()} · Market data:{" "}
            {marketDataTimestamp > 0 ? new Date(marketDataTimestamp).toLocaleString() : "unavailable"} · Direction
            locked to engine: {analysis.directionEcho}
          </p>
        </div>
      )}
    </Card>
  );
}

function Block({ title, text, wide = false }: { title: string; text: string; wide?: boolean }) {
  return (
    <div className={`rounded-xl border border-slate-800 bg-slate-950/60 p-4 ${wide ? "md:col-span-2" : ""}`}>
      <p className="text-[11px] font-bold tracking-widest text-slate-500 uppercase">{title}</p>
      <p className="mt-1.5 text-[13px] leading-relaxed text-slate-200">{text}</p>
    </div>
  );
}

function ListBlock({ title, items, tone }: { title: string; items: string[]; tone: "emerald" | "amber" | "cyan" | "rose" }) {
  const color =
    tone === "emerald" ? "text-emerald-400/80" : tone === "amber" ? "text-amber-400/80" : tone === "cyan" ? "text-cyan-400/80" : "text-rose-400/80";
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4">
      <p className={`text-[11px] font-bold tracking-widest uppercase ${color}`}>{title}</p>
      {items.length === 0 ? (
        <p className="mt-1.5 text-xs text-slate-600">None recorded.</p>
      ) : (
        <ul className="mt-1.5 space-y-1 text-xs leading-relaxed text-slate-300">
          {items.map((item, i) => (
            <li key={i}>· {item}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
