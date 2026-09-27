import { buildUserPrompt, SYSTEM_PROMPT } from "../prompts";
import { AiInvalidResponseError, AiUnavailableError, type AiAnalysis, type AiAnalysisInput, type AIProvider } from "../types";
import { validateAiResponse } from "../validate";

/**
 * HTTP LLM provider. Talks ONLY to a caller-supplied backend endpoint that
 * holds the real provider key server-side (serverless function, BFF, …).
 * The browser never sees any secret: the request carries input JSON only.
 * Active only when configured — otherwise the app uses the local explainer.
 */
export class HttpAiProvider implements AIProvider {
  readonly name = "http-llm";
  readonly kind = "http-llm" as const;
  private readonly endpoint: string;

  constructor(endpoint: string) {
    if (!endpoint || !/^https:\/\//.test(endpoint)) {
      throw new Error("HttpAiProvider requires an https:// backend endpoint.");
    }
    this.endpoint = endpoint;
  }

  async analyze(
    input: AiAnalysisInput,
    opts?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<AiAnalysis> {
    const timeoutMs = opts?.timeoutMs ?? 25_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    opts?.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      let res: Response;
      try {
        res = await fetch(this.endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ system: SYSTEM_PROMPT, user: buildUserPrompt(input), input }),
          signal: controller.signal,
        });
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
          throw new AiUnavailableError("AI request timed out.");
        }
        throw new AiUnavailableError("AI backend unreachable.");
      }
      if (!res.ok) {
        throw new AiUnavailableError(`AI backend error (HTTP ${res.status}).`);
      }
      let payload: unknown;
      try {
        payload = (await res.json()) as unknown;
      } catch {
        throw new AiInvalidResponseError("AI backend returned invalid JSON.");
      }
      // Backend may wrap: { analysis: {...} } or return the object directly.
      const candidate =
        typeof payload === "object" && payload !== null && "analysis" in payload
          ? (payload as Record<string, unknown>).analysis
          : payload;
      return validateAiResponse(candidate, {
        direction: input.signalDirection,
        provider: this.name,
        marketDataTimestamp: input.marketDataTimestamp,
      });
    } finally {
      clearTimeout(timer);
      opts?.signal?.removeEventListener("abort", onAbort);
    }
  }
}

/** Endpoint from environment (URL only — never a secret). Empty = unconfigured. */
export function aiEndpointFromEnv(): string {
  try {
    const v = (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_AI_ENDPOINT;
    return typeof v === "string" ? v.trim() : "";
  } catch {
    return "";
  }
}
