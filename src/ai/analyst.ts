import { aiSignalKey, getCachedAi, setCachedAi } from "./cache";
import { recordAiCacheHit, recordAiCacheMiss, recordAiCall } from "./stats";
import { validateAiResponse } from "./validate";
import { AiUnavailableError, type AiAnalysis, type AiAnalysisInput, type AIProvider } from "./types";
import { dedupedRequest, markCalled, throttleDelayMs } from "./ratelimit";
import { HttpAiProvider, aiEndpointFromEnv } from "./providers/httpProvider";
import { LocalExplainerProvider } from "./providers/localExplainer";

export type AiStatus = "ok" | "unavailable";

/**
 * Orchestrated AI analysis: cache → throttle → dedupe → provider → validate.
 * Never throws to the UI: failures resolve as { status: "unavailable" } so
 * the deterministic signal keeps working untouched.
 */
export async function getAiAnalysis(args: {
  input: AiAnalysisInput;
  timeframe: string;
  provider?: AIProvider;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<{ status: AiStatus; analysis: AiAnalysis | null; provider: string; cached: boolean }> {
  const { input, timeframe } = args;
  const provider = args.provider ?? defaultProvider();
  const key = aiSignalKey(input, timeframe);

  const cached = getCachedAi(key, input);
  if (cached) {
    recordAiCacheHit();
    return { status: "ok", analysis: cached, provider: cached.provider, cached: true };
  }
  recordAiCacheMiss();

  try {
    // Throttle + provider run INSIDE the deduped task so concurrent
    // identical callers share one promise (and its single wait).
    const analysis = await dedupedRequest(key, async () => {
      const innerWait = throttleDelayMs(key);
      if (innerWait > 0) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(innerWait, 3000)));
      }
      markCalled(key);
      recordAiCall();
      const raw = await provider.analyze(input, { timeoutMs: args.timeoutMs, signal: args.signal });
      // Structural guard: EVERY provider output is re-validated here, so no
      // provider (present or future) can override direction or sneak in numbers.
      return validateAiResponse(raw, {
        direction: input.signalDirection,
        provider: raw.provider || provider.name,
        marketDataTimestamp: input.marketDataTimestamp,
      });
    });
    setCachedAi(key, analysis);
    return { status: "ok", analysis, provider: analysis.provider, cached: false };
  } catch (err) {
    if (err instanceof AiUnavailableError) {
      return { status: "unavailable", analysis: null, provider: provider.name, cached: false };
    }
    // Validation failures are surfaced as unavailable — never partial output.
    return { status: "unavailable", analysis: null, provider: provider.name, cached: false };
  }
}

let singleton: AIProvider | null = null;

/** HTTP backend when VITE_AI_ENDPOINT is set, else the labeled local explainer. */
export function defaultProvider(): AIProvider {
  if (singleton) return singleton;
  const endpoint = aiEndpointFromEnv();
  singleton =
    endpoint !== "" ? new HttpAiProvider(endpoint) : new LocalExplainerProvider();
  return singleton;
}

/** Test seam: reset the provider singleton. */
export function resetDefaultProvider(): void {
  singleton = null;
}
