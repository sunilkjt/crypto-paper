import { describe, expect, it } from "vitest";
import {
  checkOnce,
  evaluateWatchdog,
  formatAge,
  type WatchdogHeartbeat,
} from "../watchdog";

const HB: WatchdogHeartbeat = {
  lastRunAt: 1_000_000,
  perCategory: {
    crypto: { universe: 142, scanned: 40, signals: 3 },
    stocks: { universe: 24, scanned: 20, signals: 1 },
    commodities: { universe: 7, scanned: 7, signals: 0 },
  },
  lastDeliveryAt: 999_000,
};

interface FakeStore {
  heartbeat: WatchdogHeartbeat | null;
  alertedAt: number | null;
  delivered: string[];
  failDeliver: boolean;
}

function fakes(store: FakeStore, now = 2_000_000, staleAfterMs = 20 * 60_000) {
  return {
    now,
    staleAfterMs,
    loadHeartbeat: async () => store.heartbeat,
    loadAlertState: async () => ({ alertedAt: store.alertedAt }),
    saveAlertState: async (s: { alertedAt: number | null }) => {
      store.alertedAt = s.alertedAt;
    },
    deliverAlert: async (text: string) => {
      if (store.failDeliver) return false;
      store.delivered.push(text);
      return true;
    },
    log: () => {},
  };
}

describe("evaluateWatchdog", () => {
  it("1: healthy scanner → no alert", () => {
    expect(
      evaluateWatchdog({ heartbeat: HB, alertedAt: null, now: 1_000_000 + 60_000, staleAfterMs: 20 * 60_000 }),
    ).toEqual({ action: "none" });
  });

  it("2: stale scanner → one alert with age and per-category lines", () => {
    const d = evaluateWatchdog({
      heartbeat: HB,
      alertedAt: null,
      now: 1_000_000 + 30 * 60_000,
      staleAfterMs: 20 * 60_000,
    });
    expect(d.action).toBe("alert");
    if (d.action === "alert") {
      expect(d.message).toContain("Stale");
      expect(d.message).toContain("30 min");
      expect(d.message).toContain("142 markets");
    }
  });

  it("3: repeated stale checks → no duplicate alert", () => {
    const d = evaluateWatchdog({
      heartbeat: HB,
      alertedAt: 1_500_000,
      now: 1_000_000 + 30 * 60_000,
      staleAfterMs: 20 * 60_000,
    });
    expect(d).toEqual({ action: "none" });
  });

  it("4: recovery → one recovery alert with outage duration", () => {
    const d = evaluateWatchdog({
      heartbeat: HB,
      alertedAt: 500_000,
      now: 1_000_000 + 60_000,
      staleAfterMs: 20 * 60_000,
    });
    expect(d.action).toBe("recover");
    if (d.action === "recover") {
      expect(d.message).toContain("Recovered");
      expect(d.outageMs).toBe(1_000_000 + 60_000 - 500_000);
    }
  });

  it("5: continued healthy operation → silent", () => {
    const d = evaluateWatchdog({ heartbeat: HB, alertedAt: null, now: 1_000_001, staleAfterMs: 20 * 60_000 });
    expect(d).toEqual({ action: "none" });
  });

  it("6: missing or malformed heartbeat → alert state, never ONLINE", () => {
    const missing = evaluateWatchdog({ heartbeat: null, alertedAt: null, now: 9_999_999, staleAfterMs: 20 * 60_000 });
    expect(missing.action).toBe("alert");
    const malformed = evaluateWatchdog({
      heartbeat: { ...HB, lastRunAt: Number.NaN },
      alertedAt: null,
      now: 9_999_999,
      staleAfterMs: 20 * 60_000,
    });
    expect(malformed.action).toBe("alert");
  });

  it("formats ages without inventing precision", () => {
    expect(formatAge(-5)).toBe("—");
    expect(formatAge(30_000)).toBe("<1 min");
    expect(formatAge(42 * 60_000)).toBe("42 min");
    expect(formatAge(135 * 60_000)).toBe("2h 15m");
  });
});

describe("checkOnce integration", () => {
  it("7: delivery failure leaves alert state untouched (recoverable)", async () => {
    const store: FakeStore = { heartbeat: null, alertedAt: null, delivered: [], failDeliver: true };
    const res = await checkOnce(fakes(store));
    expect(res.action).toBe("alert");
    expect(res.alerted).toBe(false);
    expect(res.errors.length).toBeGreaterThan(0);
    expect(store.alertedAt).toBeNull();
    expect(store.delivered).toHaveLength(0);
    // Next pass retries the same outage.
    const retry = await checkOnce(fakes(store));
    expect(retry.action).toBe("alert");
  });

  it("8: overlapping passes converge on one delivery", async () => {
    const store: FakeStore = { heartbeat: null, alertedAt: null, delivered: [], failDeliver: false };
    const first = await checkOnce(fakes(store));
    const second = await checkOnce(fakes(store));
    expect(first.alerted).toBe(true);
    expect(second.action).toBe("none");
    expect(store.delivered).toHaveLength(1);
  });

  it("recovery clears state exactly once", async () => {
    const store: FakeStore = { heartbeat: HB, alertedAt: 500_000, delivered: [], failDeliver: false };
    const res = await checkOnce({ ...fakes(store), now: 1_000_000 + 60_000 });
    expect(res.action).toBe("recover");
    expect(res.alerted).toBe(true);
    expect(store.alertedAt).toBeNull();
    const again = await checkOnce({ ...fakes(store), now: 1_000_000 + 120_000 });
    expect(again.action).toBe("none");
    expect(store.delivered).toHaveLength(1);
  });
});
