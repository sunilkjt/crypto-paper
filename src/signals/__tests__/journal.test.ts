import { describe, expect, it } from "vitest";
import {
  backfillAiSummary,
  clearJournal,
  loadJournal,
  upsertJournalSignal,
  __setJournalStorageForTests,
} from "../journal";

function memStorage(): Storage {
  const dump = new Map<string, string>();
  return {
    getItem: (k: string) => (dump.has(k) ? (dump.get(k) as string) : null),
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
  };
}
import {
  emitNotification,
  markAllNotificationsRead,
  resetNotificationsForTests,
  subscribeNotifications,
  unreadCount,
} from "../notifications";

const BASE = {
  symbol: "OP",
  direction: "LONG" as const,
  setupType: "BOUNCE" as const,
  timeframe: "15m",
  entryLow: 1.4,
  entryHigh: 1.45,
  invalidation: 1.32,
  tp1: 1.55,
  tp2: 1.65,
  tp3: 1.8,
  riskReward: 2.5,
  strength: 78,
  quality: "HIGH QUALITY" as const,
  status: "NEW" as const,
  outcome: null,
  newsHeadlines: [],
  dataTimestamp: 1000,
};

describe("journal", () => {
  it("upserts by stable ID without duplicating", () => {
    __setJournalStorageForTests(memStorage());
    try {
      clearJournal();
      const first = upsertJournalSignal({ ...BASE, id: "OP|LONG|15m|BOUNCE|1", now: 100 });
      expect(first.id).toBe("OP|LONG|15m|BOUNCE|1");
      expect(first.firstSeen).toBe(100);
      const second = upsertJournalSignal({ ...BASE, id: "OP|LONG|15m|BOUNCE|1", strength: 82, status: "ACTIVE", now: 200 });
      expect(second.strength).toBe(82);
      expect(second.status).toBe("ACTIVE");
      expect(second.firstSeen).toBe(100); // preserved across updates
      expect(loadJournal()).toHaveLength(1); // deduplicated, not duplicated
      backfillAiSummary("OP", "LONG", "engine says up");
      expect(loadJournal()[0].aiSummary).toBe("engine says up");
      clearJournal();
      expect(loadJournal()).toHaveLength(0);
    } finally {
      __setJournalStorageForTests(null);
    }
  });

  it("survives absent storage without throwing", () => {
    __setJournalStorageForTests(null);
    const e = upsertJournalSignal({ ...BASE, id: "X", now: 1 });
    expect(e.id).toBe("X");
    expect(loadJournal()).toEqual([]);
    expect(() => backfillAiSummary("OP", "LONG", "s")).not.toThrow();
    expect(() => clearJournal()).not.toThrow();
  });
});

describe("notifications", () => {
  it("emits, counts unread, and marks read", () => {
    resetNotificationsForTests();
    const seen: string[][] = [];
    const unsub = subscribeNotifications((feed) => seen.push(feed.map((n) => n.id)));
    emitNotification({ kind: "NEW_SETUP", symbol: "OP", direction: "LONG", strength: 80, message: "OP LONG NEW" });
    emitNotification({ kind: "STATE_CHANGE", symbol: "ETH", direction: "SHORT", strength: 70, message: "ETH weakening" });
    expect(seen.length).toBeGreaterThanOrEqual(3); // initial + 2 emits
    let latest: ReturnType<typeof unreadCount> = 0;
    const unsub2 = subscribeNotifications((feed) => {
      latest = unreadCount(feed);
    });
    expect(latest).toBe(2);
    markAllNotificationsRead();
    expect(latest).toBe(0);
    unsub();
    unsub2();
  });
});
