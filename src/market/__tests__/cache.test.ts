import { describe, expect, it, vi } from "vitest";
import { cached, clearCache } from "../cache";

describe("cache", () => {
  it("coalesces concurrent requests into one fetch", async () => {
    clearCache();
    const fetcher = vi.fn().mockImplementation(
      () => new Promise<string>((res) => setTimeout(() => res("v"), 20)),
    );
    const [a, b, c] = await Promise.all([
      cached("k1", 1000, fetcher),
      cached("k1", 1000, fetcher),
      cached("k1", 1000, fetcher),
    ]);
    expect(a).toBe("v");
    expect(b).toBe("v");
    expect(c).toBe("v");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("serves cached value within TTL and refetches after expiry", async () => {
    clearCache();
    let n = 0;
    const fetcher = vi.fn().mockImplementation(async () => `v${++n}`);
    expect(await cached("k2", 60_000, fetcher)).toBe("v1");
    expect(await cached("k2", 60_000, fetcher)).toBe("v1");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await cached("k2", -1, fetcher)).toBe("v2");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("clears pending slot on failure so retries work", async () => {
    clearCache();
    const fail = vi.fn().mockRejectedValue(new Error("down"));
    await expect(cached("k3", 1000, fail)).rejects.toThrow("down");
    const ok = vi.fn().mockResolvedValue("recovered");
    await expect(cached("k3", 1000, ok)).resolves.toBe("recovered");
  });
});
