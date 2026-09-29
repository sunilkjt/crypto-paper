import { describe, expect, it } from "vitest";
import { eventCategoryLabel, eventMessage, resolveEventCategory } from "../events";
import {
  __setCooldownStorageForTests,
  fingerprintOf,
  getLastNotified,
  isOutsideCooldown,
  markNotified,
  scoreBucket,
  shouldDeliver,
} from "../cooldown";
import {
  COOLDOWN_OPTIONS,
  DEFAULT_ALERT_SETTINGS,
  __setAlertSettingsStorageForTests,
  loadAlertSettings,
  passesAlertFilters,
  saveAlertSettings,
} from "../settings";
import {
  filterAlerts,
  ingestAlertEvents,
  resetAlertsForTests,
  setAlertProviders,
} from "../store";
import { formatTelegramMessage } from "../providers";
import type { SignalEvent } from "../events";

function memoryStorage(): Storage {
  const store: Record<string, string> = {};
  return {
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => {
      store[k] = v;
    },
    removeItem: (k: string) => {
      delete store[k];
    },
    clear: () => {
      for (const k of Object.keys(store)) delete store[k];
    },
    key: (i: number) => Object.keys(store)[i] ?? null,
    get length() {
      return Object.keys(store).length;
    },
  } as Storage;
}

function fp(over: Partial<Parameters<typeof fingerprintOf>[0]> = {}) {
  return fingerprintOf({
    type: "NEW_SIGNAL",
    category: "stocks",
    symbol: "xyz:AAPL",
    direction: "LONG",
    timeframe: "15m",
    entryLow: 180,
    entryHigh: 181,
    strength: 82,
    ...over,
  });
}

describe("event category resolution", () => {
  it("prefers the explicit category, falls back without false crypto claims", () => {
    expect(resolveEventCategory({ symbol: "BTC", category: "crypto" })).toBe("crypto");
    expect(resolveEventCategory({ symbol: "xyz:AAPL", category: "stocks" })).toBe("stocks");
    expect(resolveEventCategory({ symbol: "xyz:GOLD", category: "commodities" })).toBe("commodities");
    expect(resolveEventCategory({ symbol: "BTC" })).toBe("crypto");
    expect(resolveEventCategory({ symbol: "xyz:NVDA" })).toBe("other");
    expect(eventCategoryLabel({ symbol: "xyz:AAPL", category: "stocks" })).toBe("STOCK");
    expect(eventCategoryLabel({ symbol: "BTC" })).toBe("CRYPTO");
  });

  it("prefixes messages with category + direction arrow", () => {
    const msg = eventMessage({
      type: "NEW_SIGNAL",
      symbol: "xyz:AAPL",
      direction: "LONG",
      currentStrength: 84,
      detail: null,
      category: "stocks",
    });
    expect(msg).toContain("STOCK");
    expect(msg).toContain("📈");
    expect(msg).toContain("xyz:AAPL");
    const short = eventMessage({
      type: "NEW_SIGNAL",
      symbol: "xyz:GOLD",
      direction: "SHORT",
      currentStrength: 79,
      detail: null,
      category: "commodities",
    });
    expect(short).toContain("COMMODITY");
    expect(short).toContain("📉");
  });
});

describe("notification fingerprint", () => {
  it("buckets scores by 5 (82 and 83 collide, 86 does not)", () => {
    expect(scoreBucket(82)).toBe(80);
    expect(scoreBucket(83)).toBe(80);
    expect(scoreBucket(86)).toBe(85);
    expect(fp()).toBe(fp({ strength: 83 }));
    expect(fp()).not.toBe(fp({ strength: 86 }));
  });

  it("separates category, direction, type and entry zone", () => {
    const base = fp();
    expect(fp({ category: "commodities", symbol: "xyz:GOLD" })).not.toBe(base);
    expect(fp({ direction: "SHORT" })).not.toBe(base);
    expect(fp({ type: "SIGNAL_INVALIDATED" })).not.toBe(base);
    expect(fp({ entryLow: 179 })).not.toBe(base);
    expect(fp({ timeframe: "1h" })).not.toBe(base);
    // Same symbol text in another class can never collide.
    expect(
      fp({ category: "stocks", symbol: "X" }),
    ).not.toBe(fp({ category: "commodities", symbol: "X" }));
  });

  it("WAIT→LONG, LONG→SHORT notify; LONG→LONG repeats share the key", () => {
    const first = fp({ type: "NEW_SIGNAL" });
    const repeat = fp({ type: "NEW_SIGNAL" });
    const flip = fp({ type: "NEW_SIGNAL", direction: "SHORT" });
    expect(repeat).toBe(first);
    expect(flip).not.toBe(first);
  });
});

describe("notification cooldown", () => {
  it("allows first delivery, suppresses in-window repeats, allows after expiry", () => {
    expect(isOutsideCooldown(undefined, 1000, 1_800_000)).toBe(true);
    expect(isOutsideCooldown(1000, 1000 + 60_000, 1_800_000)).toBe(false);
    expect(isOutsideCooldown(1000, 1000 + 1_800_000, 1_800_000)).toBe(true);
    expect(isOutsideCooldown(1000, 1000 + 1, 0)).toBe(true); // disabled
  });

  it("persists marks and gates delivery end to end", () => {
    __setCooldownStorageForTests(memoryStorage());
    const f = fp();
    expect(shouldDeliver(f, 5000, 1_800_000)).toBe(true);
    markNotified(f, 5000);
    expect(getLastNotified(f)).toBe(5000);
    expect(shouldDeliver(f, 6000, 1_800_000)).toBe(false);
    expect(shouldDeliver(f, 5000 + 1_800_001, 1_800_000)).toBe(true);
    __setCooldownStorageForTests(null);
  });
});

describe("notification settings (categories + cooldown)", () => {
  it("defaults all categories on with a 30-minute cooldown", () => {
    expect(DEFAULT_ALERT_SETTINGS.categories).toEqual({ crypto: true, stocks: true, commodities: true });
    expect(DEFAULT_ALERT_SETTINGS.cooldownMs).toBe(1_800_000);
    expect(COOLDOWN_OPTIONS.map((o) => o.value)).toContain(0);
  });

  it("gates candidates per category without touching signals", () => {
    const base = {
      strength: 84,
      direction: "LONG" as const,
      setupType: "TREND",
      timeframe: "15m",
      watched: false,
    };
    const off = { ...DEFAULT_ALERT_SETTINGS, categories: { crypto: true, stocks: false, commodities: true } };
    expect(passesAlertFilters({ ...base, category: "stocks" }, off)).toBe(false);
    expect(passesAlertFilters({ ...base, category: "commodities" }, off)).toBe(true);
    expect(passesAlertFilters({ ...base, category: "crypto" }, off)).toBe(true);
    expect(passesAlertFilters({ ...base }, off)).toBe(true); // legacy: no restriction
    const noLong = { ...DEFAULT_ALERT_SETTINGS, directions: ["SHORT"] as ("LONG" | "SHORT")[] };
    expect(passesAlertFilters({ ...base, category: "stocks" }, noLong)).toBe(false);
  });

  it("merges stored legacy settings forward (missing fields default on)", () => {
    __setAlertSettingsStorageForTests(memoryStorage());
    saveAlertSettings({ ...DEFAULT_ALERT_SETTINGS, minStrength: 80 } as never);
    const loaded = loadAlertSettings();
    expect(loaded.minStrength).toBe(80);
    expect(loaded.categories).toEqual({ crypto: true, stocks: true, commodities: true });
    expect(loaded.cooldownMs).toBe(1_800_000);
    expect(loaded.inAppNotifications).toBe(true);
    __setAlertSettingsStorageForTests(null);
  });
});

describe("delivery cooldown gate (history records, providers gated)", () => {
  const stockEvent = (id: string): SignalEvent => ({
    id,
    type: "NEW_SIGNAL",
    symbol: "xyz:AAPL",
    direction: "LONG",
    setupType: "TREND",
    timeframe: "15m",
    previousStrength: null,
    currentStrength: 84,
    detail: null,
    status: "NEW",
    timestamp: 10_000,
    signal: {
      entryLow: 180,
      entryHigh: 181,
      invalidation: 175,
      tp1: 190,
      tp2: 195,
      tp3: 200,
      riskReward: 2,
    } as never,
    watched: false,
    read: false,
    category: "stocks",
  });

  it("records history but notifies providers only outside cooldown", () => {
    resetAlertsForTests();
    __setCooldownStorageForTests(memoryStorage());
    __setAlertSettingsStorageForTests(memoryStorage());
    const notified: string[] = [];
    setAlertProviders([{ name: "sound" as const, isAvailable: () => true, notify: (e) => void notified.push(e.id) }]);
    // First sighting: history + delivery.
    expect(ingestAlertEvents([stockEvent("s1")])).toHaveLength(1);
    expect(notified).toEqual(["s1"]);
    // Same fact, new stable ID (re-emitted lifecycle): history + NO delivery.
    expect(ingestAlertEvents([stockEvent("s2")])).toHaveLength(1);
    expect(notified).toEqual(["s1"]);
    // Different fact (SHORT flip): delivery resumes.
    const flip = { ...stockEvent("s3"), direction: "SHORT" as const };
    expect(ingestAlertEvents([flip])).toHaveLength(1);
    expect(notified).toEqual(["s1", "s3"]);
    setAlertProviders([]);
    resetAlertsForTests();
    __setCooldownStorageForTests(null);
    __setAlertSettingsStorageForTests(null);
  });
});

describe("provider messages carry category, never secrets", () => {
  it("telegram format leads with the market class", () => {
    const msg = formatTelegramMessage({
      id: "x",
      type: "NEW_SIGNAL",
      symbol: "xyz:GOLD",
      direction: "SHORT",
      setupType: "TREND",
      timeframe: "15m",
      previousStrength: null,
      currentStrength: 79,
      detail: null,
      status: "NEW",
      timestamp: 1,
      signal: { entryLow: 1, entryHigh: 2, invalidation: 0, tp1: 3, tp2: 4, tp3: 5, riskReward: 2, reasons: [], warnings: [] } as never,
      watched: false,
      read: false,
      category: "commodities",
    });
    expect(msg.split("\n")[0]).toContain("COMMODITY");
    expect(msg).toContain("xyz:GOLD");
    expect(msg).not.toMatch(/GROQ_API_KEY|VITE_GROQ|sb_secret|service_role/i);
  });
});

describe("alert history category filter", () => {
  const ev = (symbol: string, category?: "crypto" | "stocks" | "commodities") => ({
    id: `${symbol}-NEW_SIGNAL`,
    type: "NEW_SIGNAL" as const,
    symbol,
    direction: "LONG" as const,
    setupType: "TREND" as const,
    timeframe: "15m",
    previousStrength: null,
    currentStrength: 84,
    detail: null,
    status: "NEW" as const,
    timestamp: 1000,
    signal: {} as never,
    watched: false,
    read: false,
    ...(category === undefined ? {} : { category }),
  });

  it("filters All/Crypto/Stocks/Commodities with legacy fallback", () => {
    const events = [ev("BTC", "crypto"), ev("xyz:AAPL", "stocks"), ev("xyz:GOLD", "commodities"), ev("OP")];
    const base = { coin: "ALL", direction: "ALL", event: "ALL", sinceMs: null } as const;
    expect(filterAlerts(events, { ...base, category: "ALL" })).toHaveLength(4);
    expect(filterAlerts(events, { ...base, category: "crypto" }).map((e) => e.symbol)).toEqual(["BTC", "OP"]);
    expect(filterAlerts(events, { ...base, category: "stocks" }).map((e) => e.symbol)).toEqual(["xyz:AAPL"]);
    expect(filterAlerts(events, { ...base, category: "commodities" }).map((e) => e.symbol)).toEqual(["xyz:GOLD"]);
  });
});
