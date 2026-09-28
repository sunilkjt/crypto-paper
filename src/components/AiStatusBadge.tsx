import { aiEndpointFromEnv } from "../ai";
import { cn } from "../lib/cn";

/**
 * AI backend status pill. Honest by construction:
 * - endpoint set → "AI Ready" (secure backend; the engine still decides)
 * - empty → "AI Local only" (deterministic on-device explainer, no LLM)
 * Per-call failures surface inside the analysis cards themselves.
 */
export function AiStatusBadge() {
  const ready = aiEndpointFromEnv() !== "";
  return (
    <span
      className={cn(
        "inline-flex min-h-[28px] items-center gap-1.5 rounded-full border px-3 py-1 text-[11px] font-bold",
        ready
          ? "border-cyan-400/30 bg-cyan-400/10 text-cyan-200"
          : "border-slate-800 bg-slate-900 text-slate-400",
      )}
      title={
        ready
          ? "AI explanations are served by the secure Gemini backend. The deterministic engine still makes every trading decision."
          : "No AI backend configured — the deterministic local explainer is active (not an LLM)."
      }
    >
      <span aria-hidden="true">{ready ? "●" : "○"}</span> AI {ready ? "Ready" : "Local only"}
    </span>
  );
}
