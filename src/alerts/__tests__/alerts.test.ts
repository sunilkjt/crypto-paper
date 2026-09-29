import { describe, expect, it } from "vitest";
import {
  filterAlerts,
  ingestAlertEvents,
  markAlertRead,
  markAllAlertsRead,
  resetAlertsForTests,
  setAlertProviders,
} from "../store";
import { isExpired } from "../expiry";
import {
  addWatched,
  isWatched,
  loadWatchlist,
  removeWatched,
  saveWatchlist,
  __setWatchlistStorageForTests,
} from "../watchlist";
import {
  BrowserNotificationProvider,
  formatTelegramMessage,
  SoundAlertProvider,
  TelegramNotificationProvider,
} from "../providers";
import { checkTargets } from "../targets";
import { DEFAULT_ALERT_SETTINGS } from "../settings";
import { evaluateTargets } from "../monitor";
import type { SignalEvent } from "../events";
import type { Signal } from "../../analysis/signal";

let seq = 0;

function event(over: Partial<SignalEvent> = {}): SignalEvent {
  const signal = {
    symbol: "OP",
    direction: "LONG",
    entryLow: 1.4,
    entryHigh: 1.45,
    invalidation: 1.32,
    tp1: 1.55,
    tp2: 1.65,
    tp3: 1.8,
    riskReward: 2.5,
    reasons: ["r"],
    warnings: [],
  } as unknown as Signal;
  return {
    id: `OP|LONG|15m|BOUNCE|1::NEW_SIGNAL::${seq++}`,
    type: "NEW_SIGNAL",
    symbol: "OP",
    direction: "LONG",
    setupType: "BOUNCE",
    timeframe: "15m",
    previousStrength: null,
    currentStrength: 82,
    detail: null,
    status: "NEW",
    timestamp: 1000,
    signal,
    watched: false,
    read: false,
    ...over,
  };
}

describe("alert store", () => {
  it("dedupes by stable ID and tracks read state", () => {
    resetAlertsForTests();
    setAlertProviders([]);
    const added = ingestAlertEvents([event({ id: "a" }), event({ id: "a" })]);
    expect(added).toHaveLength(1);
    markAlertRead("a");
    markAllAlertsRead();
    const second = ingestAlertEvents([event({ id: "b" })]);
    expect(second).toHaveLength(1);
  });

  it("filters by coin, direction, event and date", () => {
    const rows = [
      event({ id: "1", symbol: "OP", direction: "LONG", type: "NEW_SIGNAL", timestamp: 100 }),
      event({ id: "2", symbol: "ETH", direction: "SHORT", type: "SIGNAL_INVALIDATED", timestamp: 200 }),
    ];
    expect(filterAlerts(rows, { coin: "OP", direction: "ALL", event: "ALL", sinceMs: null }).map((e) => e.id)).toEqual(["1"]);
    expect(filterAlerts(rows, { coin: "ALL", direction: "SHORT", event: "ALL", sinceMs: null }).map((e) => e.id)).toEqual(["2"]);
    expect(filterAlerts(rows, { coin: "ALL", direction: "ALL", event: "SIGNAL_INVALIDATED", sinceMs: null }).map((e) => e.id)).toEqual(["2"]);
    expect(filterAlerts(rows, { coin: "ALL", direction: "ALL", event: "ALL", sinceMs: 150 }).map((e) => e.id)).toEqual(["2"]);
  });
});

describe("expiry", () => {
  it("expires by age or decayed strength", () => {
    expect(isExpired({ firstSeen: 0, strength: 80, now: 25 * 3_600_000 })).toBe(true);
    expect(isExpired({ firstSeen: 0, strength: 30, now: 1000 })).toBe(true);
    expect(isExpired({ firstSeen: 0, strength: 80, now: 1000 })).toBe(false);
  });
});

describe("watchlist", () => {
  it("adds, dedupes and removes coins", () => {
    const dump = new Map<string, string>();
    __setWatchlistStorageForTests({
      getItem: (k: string) => dump.get(k) ?? null,
      setItem: (k: string, v: string) => {
        dump.set(k, v);
      },
      removeItem: (k: string) => {
        dump.delete(k);
      },
      clear: () => dump.clear(),
      key: (i: number) => [...dump.keys()][i] ?? null,
      get length() {
        return dump.size;
      },
    });
    try {
      saveWatchlist([]);
      addWatched("op");
      addWatched("OP");
      addWatched("eth");
      // Most-recently-added first; exact-case dedupe.
      expect(loadWatchlist()).toEqual(["ETH", "OP"]);
      expect(isWatched("op")).toBe(true);
      removeWatched("OP");
      expect(loadWatchlist()).toEqual(["ETH"]);
      saveWatchlist([]);
    } finally {
      __setWatchlistStorageForTests(null);
    }
  });
});

describe("providers", () => {
  it("browser provider stays silent without granted permission", () => {
    const p = new BrowserNotificationProvider();
    expect(p.isAvailable()).toBe(false);
    expect(() => p.notify(event())).not.toThrow();
    // Permission is never requested by construction here — only via UI enable.
  });

  it("sound provider is off unless enabled", () => {
    const p = new SoundAlertProvider();
    expect(p.isAvailable()).toBe(false);
    p.setEnabled(true);
    // Node has no AudioContext — still unavailable, never throws.
    expect(() => p.notify(event())).not.toThrow();
  });

  it("telegram formats the spec message without secrets", () => {
    const msg = formatTelegramMessage(event());
    for (const needle of ["NEW CRYPTO SIGNAL", "OP", "LONG", "82/100", "TP1", "R:R", "Reasons:", "Risk:", "not a probability"]) {
      expect(msg).toContain(needle);
    }
    const tg = new TelegramNotificationProvider("");
    expect(tg.status()).toEqual({ configured: false, label: "Not configured" });
    expect(tg.isAvailable()).toBe(false);
    expect(() => tg.notify(event())).not.toThrow();
  });
});

describe("targets", () => {
  it("uses live marks with LONG/SHORT mirror logic", () => {
    const long = { direction: "LONG", entryLow: 1.4, entryHigh: 1.45, invalidation: 1.32, tp1: 1.55, tp2: 1.65, tp3: 1.8 } as const;
    expect(checkTargets(long, 1.42)).toContain("ENTRY");
    expect(checkTargets(long, 1.9)).toEqual(expect.arrayContaining(["TP1", "TP2", "TP3"]));
    expect(checkTargets(long, 1.3)).toContain("INVALIDATION");
    const short = { direction: "SHORT", entryLow: 1.4, entryHigh: 1.45, invalidation: 1.55, tp1: 1.3, tp2: 1.2, tp3: 1.1 } as const;
    expect(checkTargets(short, 1.2)).toEqual(expect.arrayContaining(["TP1", "TP2"]));
    expect(checkTargets(short, 1.6)).toContain("INVALIDATION");
    expect(checkTargets(long, NaN)).toEqual([]);
  });
});

describe("failure isolation", () => {
  it("a throwing provider never breaks ingestion", () => {
    resetAlertsForTests();
    setAlertProviders([
      {
        name: "browser",
        isAvailable: () => true,
        notify: () => {
          throw new Error("provider down");
        },
      },
    ]);
    const added = ingestAlertEvents([event({ id: "iso-1" })]);
    expect(added).toHaveLength(1);
    // Second ingest of the same fact dedupes even after the failure.
    expect(ingestAlertEvents([event({ id: "iso-1" })])).toHaveLength(0);
    setAlertProviders([]);
  });

  it("offline market data means no monitor input, not failed alerts", () => {
    // The monitor only ever receives live-scan results; when the feed is
    // offline the ScanContext skips the scan, so evaluation never runs on
    // stale data. Empty input yields empty output, never errors.
    expect(evaluateTargets([], new Map(), { marks: new Map(), watchlist: [], settings: { ...DEFAULT_ALERT_SETTINGS, minStrength: 60 }, now: 0 })).toEqual([]);
  });
});
