import { describe, expect, it } from "vitest";
import {
  applyRateLimitOverride,
  connectionToLegacyStatus,
  RATE_LIMITED_BADGE_MS,
} from "../connection";

describe("rate limit override", () => {
  it("forces RATE LIMITED with a countdown inside the badge window", () => {
    const now = 1_000_000;
    const at = now - 2_000;
    const { state, view } = applyRateLimitOverride("ONLINE", at, now);
    expect(state).toBe("RATE_LIMITED");
    expect(view.limited).toBe(true);
    expect(view.retryInSec).toBe(Math.ceil((RATE_LIMITED_BADGE_MS - 2_000) / 1000));
  });

  it("releases back to the derived state after the window", () => {
    const now = 1_000_000;
    const old = now - RATE_LIMITED_BADGE_MS - 1;
    expect(applyRateLimitOverride("ONLINE", old, now).state).toBe("ONLINE");
    expect(applyRateLimitOverride("DEGRADED", old, now).view.limited).toBe(false);
    expect(applyRateLimitOverride("OFFLINE", 0, now).state).toBe("OFFLINE");
  });
});

describe("legacy mapping", () => {
  it("covers all six states without changing signal math inputs", () => {
    expect(connectionToLegacyStatus("ONLINE")).toBe("live");
    expect(connectionToLegacyStatus("CONNECTING")).toBe("loading");
    expect(connectionToLegacyStatus("RECONNECTING")).toBe("loading");
    expect(connectionToLegacyStatus("DEGRADED")).toBe("stale");
    expect(connectionToLegacyStatus("RATE_LIMITED")).toBe("stale");
    expect(connectionToLegacyStatus("OFFLINE")).toBe("error");
  });
});
