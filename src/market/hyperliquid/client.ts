import { HyperliquidError } from "./types";
import { recordRateLimit, recordRestRequest } from "../diagnostics";

export const INFO_URL = "https://api.hyperliquid.xyz/info";
export const WS_URL = "wss://api.hyperliquid.xyz/ws";

const DEFAULT_TIMEOUT_MS = 12_000;

function isRateLimitStatus(status: number): boolean {
  return status === 429;
}

function errorMessageForStatus(status: number, bodyText: string): string {
  if (status === 429)
    return "Hyperliquid rate limit hit. Retrying with backoff…";
  if (status >= 500)
    return "Unable to retrieve Hyperliquid market data. Retrying…";
  return `Hyperliquid request failed (HTTP ${status}). ${bodyText.slice(0, 160)}`;
}

/**
 * Single POST helper for the public /info endpoint.
 * No API keys. Timeout + typed errors. No raw responses leak —
 * callers parse/validate the unknown payload themselves.
 */
export async function postInfo<TBody extends Record<string, unknown>>(
  body: TBody,
  opts?: { timeoutMs?: number; signal?: AbortSignal },
): Promise<unknown> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  // Link caller cancellation to our controller.
  const onAbort = () => controller.abort();
  opts?.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    let res: Response;
    try {
      recordRestRequest();
      res = await fetch(INFO_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        if (opts?.signal?.aborted) {
          throw new HyperliquidError("network", "Request cancelled.", false);
        }
        throw new HyperliquidError(
          "timeout",
          "Unable to retrieve Hyperliquid market data (timeout). Retrying…",
          true,
        );
      }
      throw new HyperliquidError(
        "network",
        "Unable to retrieve Hyperliquid market data (network). Retrying…",
        true,
      );
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      if (isRateLimitStatus(res.status)) {
        recordRateLimit();
        throw new HyperliquidError("rate-limited", errorMessageForStatus(res.status, text), true);
      }
      throw new HyperliquidError("api", errorMessageForStatus(res.status, text), res.status >= 500);
    }

    try {
      return (await res.json()) as unknown;
    } catch {
      throw new HyperliquidError(
        "invalid-response",
        "Unable to retrieve Hyperliquid market data (invalid JSON). Retrying…",
        true,
      );
    }
  } finally {
    clearTimeout(timer);
    opts?.signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Retry policy for transient Hyperliquid failures.
 *
 * AUDIT NOTE — why "rate limit hit" appeared: the scanner fans out ~160
 * candle POSTs per run (8 concurrent) while `getMarkets` fires ~11 parallel
 * per-dex POSTs with no bound, and every 30s snapshot poll bypassed the
 * cache. Bursts like that trip Hyperliquid's IP rate limit (HTTP 429).
 * Previously NOTHING retried — the error text promised backoff that did
 * not exist; only the next poll cycle recovered. This wrapper implements
 * the actual exponential backoff with jitter, a retry cap, and a delay
 * ceiling. Permanent errors (missing market/candles, cancellations,
 * malformed shapes) are never retried.
 */
export const RETRY_POLICY = {
  maxRetries: 4,
  baseDelayMs: 500,
  maxDelayMs: 8_000,
  /** ±25% jitter so concurrent callers don't retry in lockstep. */
  jitterRatio: 0.25,
} as const;

export function isRetryableError(err: unknown): boolean {
  if (err instanceof HyperliquidError) {
    // Malformed shapes indicate a code/API contract mismatch, not a
    // transient blip — retrying would burn quota delaying the honest error.
    if (err.kind === "invalid-response") return false;
    return err.retryable;
  }
  return false;
}

export function backoffDelayMs(attempt: number, random: () => number = Math.random): number {
  const exp = RETRY_POLICY.baseDelayMs * 2 ** attempt;
  const capped = Math.min(exp, RETRY_POLICY.maxDelayMs);
  const jitter = 1 + (random() * 2 - 1) * RETRY_POLICY.jitterRatio;
  return Math.max(0, Math.round(capped * jitter));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * postInfo with bounded retries for transient failures only.
 * Single-attempt postInfo stays untouched (unit tests pin its mapping).
 */
export async function postInfoWithRetry<TBody extends Record<string, unknown>>(
  body: TBody,
  opts?: { timeoutMs?: number; signal?: AbortSignal; maxRetries?: number; random?: () => number },
): Promise<unknown> {
  const maxRetries = opts?.maxRetries ?? RETRY_POLICY.maxRetries;
  let attempt = 0;
  for (;;) {
    try {
      return await postInfo(body, opts);
    } catch (err) {
      const retryable = isRetryableError(err);
      if (!retryable || attempt >= maxRetries || opts?.signal?.aborted) throw err;
      await sleep(backoffDelayMs(attempt, opts?.random));
      attempt += 1;
    }
  }
}
