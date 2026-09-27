import { useEffect, useMemo, useState } from "react";
import { getAiAnalysis, type AiAnalysis, type AiAnalysisInput } from "./index";

/**
 * AI analysis for one structured input. Requests only when `enabled`
 * (signal present + market data fresh); stale data never triggers a call.
 * Loading / unavailable states are explicit — the engine UI is untouched.
 */
export interface AiHookState {
  state: "idle" | "loading" | "ok" | "unavailable";
  analysis: AiAnalysis | null;
  provider: string;
  cached: boolean;
}

export function useAiAnalysis(
  input: AiAnalysisInput | null,
  timeframe: string,
  enabled: boolean,
): AiHookState {
  const key = useMemo(() => {
    if (!input || !enabled) return null;
    return `${input.symbol}:${timeframe}:${input.analysisTimestamp}:${input.marketDataTimestamp}`;
  }, [input, timeframe, enabled]);

  const [state, setState] = useState<AiHookState>({
    state: "idle",
    analysis: null,
    provider: "",
    cached: false,
  });

  useEffect(() => {
    if (!key || !input) {
      setState({ state: "idle", analysis: null, provider: "", cached: false });
      return;
    }
    let cancelled = false;
    setState((s) => ({ ...s, state: "loading" }));
    void getAiAnalysis({ input, timeframe }).then((res) => {
      if (cancelled) return;
      if (res.status === "ok" && res.analysis) {
        setState({ state: "ok", analysis: res.analysis, provider: res.provider, cached: res.cached });
      } else {
        setState({ state: "unavailable", analysis: null, provider: res.provider, cached: false });
      }
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return state;
}
