import { describe, expect, it } from "vitest";
import {
  CONNECTION_THRESHOLDS,
  deriveConnection,
  formatLastUpdate,
} from "../connection";

const T = CONNECTION_THRESHOLDS;

describe("deriveConnection", () => {
  it("is CONNECTING before the grace period with no data", () => {
    expect(
      deriveConnection(
        { lastSuccessAt: 0, startedAt: 1000, consecutiveFailures: 0, hasData: false },
        1000 + T.connectingGraceMs - 1,
      ),
    ).toBe("CONNECTING");
  });

  it("is OFFLINE after the grace period with no data ever", () => {
    expect(
      deriveConnection(
        { lastSuccessAt: 0, startedAt: 1000, consecutiveFailures: 1, hasData: false },
        1000 + T.connectingGraceMs + 1,
      ),
    ).toBe("OFFLINE");
  });

  it("is ONLINE only after recently received data", () => {
    const now = 1_000_000;
    expect(
      deriveConnection(
        { lastSuccessAt: now - 10_000, startedAt: 0, consecutiveFailures: 0, hasData: true },
        now,
      ),
    ).toBe("ONLINE");
  });

  it("downgrades fresh data to DEGRADED after repeated failures", () => {
    const now = 1_000_000;
    expect(
      deriveConnection(
        {
          lastSuccessAt: now - 10_000,
          startedAt: 0,
          consecutiveFailures: T.degradedAfterFailures,
          hasData: true,
        },
        now,
      ),
    ).toBe("DEGRADED");
  });

  it("is DEGRADED while aging data is still usable", () => {
    const now = 1_000_000;
    expect(
      deriveConnection(
        {
          lastSuccessAt: now - T.onlineWithinMs - 1,
          startedAt: 0,
          consecutiveFailures: 0,
          hasData: true,
        },
        now,
      ),
    ).toBe("DEGRADED");
  });

  it("is OFFLINE when data is too old or failures pile up", () => {
    const now = 1_000_000;
    expect(
      deriveConnection(
        {
          lastSuccessAt: now - T.offlineAfterMs - 1,
          startedAt: 0,
          consecutiveFailures: 0,
          hasData: true,
        },
        now,
      ),
    ).toBe("OFFLINE");
    expect(
      deriveConnection(
        {
          lastSuccessAt: now - 1_000,
          startedAt: 0,
          consecutiveFailures: T.offlineAfterFailures,
          hasData: true,
        },
        now,
      ),
    ).toBe("OFFLINE");
  });
});

describe("formatLastUpdate", () => {
  it("labels never/just-now/seconds/minutes", () => {
    const now = 1_000_000;
    expect(formatLastUpdate(0, now)).toBe("Last update: never");
    expect(formatLastUpdate(now - 2_000, now)).toBe("Last update: just now");
    expect(formatLastUpdate(now - 30_000, now)).toBe("Last update: 30 seconds ago");
    expect(formatLastUpdate(now - 180_000, now)).toBe("Last update: 3 minutes ago");
  });
});
