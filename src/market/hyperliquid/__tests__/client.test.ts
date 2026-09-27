import { describe, expect, it, vi, afterEach } from "vitest";
import { postInfo } from "../client";
import { HyperliquidError } from "../types";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("postInfo error handling", () => {
  it("maps network failure to HyperliquidError(network)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    await expect(postInfo({ type: "allMids" }, { timeoutMs: 50 })).rejects.toMatchObject({
      name: "HyperliquidError",
    });
  });

  it("maps HTTP 429 to rate-limited", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("slow down", { status: 429 })),
    );
    const err = await postInfo({ type: "allMids" }).catch((e) => e);
    expect(err).toBeInstanceOf(HyperliquidError);
    expect((err as HyperliquidError).kind).toBe("rate-limited");
  });

  it("maps HTTP 500 to retryable api error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("boom", { status: 500 })),
    );
    const err = await postInfo({ type: "allMids" }).catch((e) => e);
    expect(err).toBeInstanceOf(HyperliquidError);
    expect((err as HyperliquidError).retryable).toBe(true);
  });

  it("maps invalid JSON to invalid-response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("not-json{", { status: 200 })),
    );
    const err = await postInfo({ type: "allMids" }).catch((e) => e);
    expect(err).toBeInstanceOf(HyperliquidError);
    expect((err as HyperliquidError).kind).toBe("invalid-response");
  });

  it("returns parsed JSON on success without leaking fetch details", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ BTC: "1" }), { status: 200 }),
      ),
    );
    await expect(postInfo({ type: "allMids" })).resolves.toEqual({ BTC: "1" });
  });
});
