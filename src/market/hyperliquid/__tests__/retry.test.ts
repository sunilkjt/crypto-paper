import { afterEach, describe, expect, it, vi } from "vitest";
import {
  backoffDelayMs,
  isRetryableError,
  postInfoWithRetry,
  RETRY_POLICY,
} from "../client";
import { HyperliquidError } from "../types";

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("backoff", () => {
  it("grows exponentially with ±25% jitter and an 8s ceiling", () => {
    expect(backoffDelayMs(0, () => 0.5)).toBe(500);
    expect(backoffDelayMs(1, () => 0.5)).toBe(1000);
    expect(backoffDelayMs(0, () => 0)).toBe(375);
    expect(backoffDelayMs(0, () => 1)).toBe(625);
    expect(backoffDelayMs(10, () => 0.5)).toBe(RETRY_POLICY.maxDelayMs);
    expect(backoffDelayMs(0, () => 0.5)).toBeGreaterThanOrEqual(0);
  });

  it("retries only transient failures", () => {
    expect(isRetryableError(new HyperliquidError("rate-limited", "x"))).toBe(true);
    expect(isRetryableError(new HyperliquidError("timeout", "x"))).toBe(true);
    expect(isRetryableError(new HyperliquidError("network", "x"))).toBe(true);
    expect(isRetryableError(new HyperliquidError("api", "x", true))).toBe(true);
    expect(isRetryableError(new HyperliquidError("missing-market", "x", false))).toBe(false);
    expect(isRetryableError(new HyperliquidError("missing-candles", "x", false))).toBe(false);
    expect(isRetryableError(new HyperliquidError("invalid-response", "x"))).toBe(false);
    expect(isRetryableError(new Error("boom"))).toBe(false);
  });
});

describe("postInfoWithRetry", () => {
  it("recovers after two 429s (3 attempts total)", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => {
        calls += 1;
        if (calls < 3) return Promise.resolve(new Response("slow", { status: 429 }));
        return Promise.resolve(jsonResponse({ BTC: "1" }));
      }),
    );
    await expect(
      postInfoWithRetry({ type: "allMids" }, { random: () => 0.5 }),
    ).resolves.toEqual({ BTC: "1" });
    expect(calls).toBe(3);
  }, 15000);

  it("never retries permanent errors", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => {
        calls += 1;
        return Promise.resolve(new Response("bad", { status: 400 }));
      }),
    );
    await expect(postInfoWithRetry({ type: "allMids" }, { random: () => 0.5 })).rejects.toBeInstanceOf(
      HyperliquidError,
    );
    expect(calls).toBe(1);
  });

  it("gives up after maxRetries and surfaces the last error", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => {
        calls += 1;
        return Promise.resolve(new Response("slow", { status: 429 }));
      }),
    );
    await expect(
      postInfoWithRetry({ type: "allMids" }, { maxRetries: 2, random: () => 0 }),
    ).rejects.toMatchObject({ kind: "rate-limited" });
    expect(calls).toBe(3); // initial + 2 retries, never infinite
  }, 15000);

  it("does not retry cancelled requests", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_url: string, opts: { signal?: AbortSignal }) => {
        calls += 1;
        const err = new DOMException("aborted", "AbortError");
        return Promise.reject(opts.signal?.aborted ? err : err);
      }),
    );
    await expect(postInfoWithRetry({ type: "allMids" }, { signal: ctrl.signal })).rejects.toBeInstanceOf(
      HyperliquidError,
    );
    expect(calls).toBe(1);
  });
});
