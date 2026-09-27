import { describe, expect, it } from "vitest";
import {
  SNAPSHOT_MAX_AGE_MS,
  clearMarketsSnapshot,
  decodeSnapshot,
  encodeSnapshot,
  loadMarketsSnapshot,
  saveMarketsSnapshot,
  type SnapshotStorage,
} from "../persist";
import type { Market } from "../hyperliquid/types";

function memStorage(): SnapshotStorage & { dump: Map<string, string> } {
  const dump = new Map<string, string>();
  return {
    dump,
    getItem: (k: string) => (dump.has(k) ? dump.get(k) as string : null),
    setItem: (k: string, v: string) => {
      dump.set(k, v);
    },
    removeItem: (k: string) => {
      dump.delete(k);
    },
  };
}

const MKT: Market = {
  symbol: "BTC",
  markPrice: 60000,
  oraclePrice: 60010,
  dayVolumeNotional: 1000000,
  dayChangePct: 3.4,
  fundingRate: 0.0001,
  openInterestCoins: 100,
  openInterestNotional: 6000000,
  prevDayPrice: 58000,
  midPrice: 59990,
};

describe("persist", () => {
  it("round-trips a snapshot through storage", () => {
    const s = memStorage();
    saveMarketsSnapshot({ markets: [MKT], updatedAt: 1_000_000 }, s);
    expect(loadMarketsSnapshot(s, 1_000_000 + 1000)).toEqual({
      markets: [MKT],
      updatedAt: 1_000_000,
    });
  });

  it("rejects corrupt, empty, ancient or oversized snapshots", () => {
    expect(decodeSnapshot(null)).toBeNull();
    expect(decodeSnapshot("not-json{")).toBeNull();
    expect(decodeSnapshot(encodeSnapshot({ markets: [], updatedAt: 1 }))).toBeNull();
    const old = encodeSnapshot({ markets: [MKT], updatedAt: 1 });
    expect(decodeSnapshot(old, 1 + SNAPSHOT_MAX_AGE_MS + 1)).toBeNull();
    expect(decodeSnapshot(JSON.stringify({ markets: [{ symbol: 5 }], updatedAt: 10 }), 11)).toBeNull();
  });

  it("filters invalid market rows but keeps valid ones", () => {
    const raw = JSON.stringify({ markets: [{ symbol: "" }, MKT], updatedAt: 100 });
    expect(decodeSnapshot(raw, 101)?.markets).toEqual([MKT]);
  });

  it("returns null without storage and clears on demand", () => {
    expect(loadMarketsSnapshot(null)).toBeNull();
    const s = memStorage();
    saveMarketsSnapshot({ markets: [MKT], updatedAt: 5 }, s);
    clearMarketsSnapshot(s);
    expect(s.dump.size).toBe(0);
  });

  it("never throws on hostile storage", () => {
    const bad: SnapshotStorage = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    };
    expect(loadMarketsSnapshot(bad)).toBeNull();
    expect(() => saveMarketsSnapshot({ markets: [MKT], updatedAt: 1 }, bad)).not.toThrow();
    expect(() => clearMarketsSnapshot(bad)).not.toThrow();
  });
});
