import {
  applyPaperTick,
  closePaperPosition,
  emptySnapshot,
  openPaperPosition,
  unrealizedFor,
  type OpenPaperArgs,
} from "./portfolio";
import type { PaperConfig, PaperPosition, PaperSnapshot } from "./types";

/**
 * Paper engine: owns the simulated account, persists to a replaceable
 * storage backend (localStorage default — no credentials ever stored),
 * and optionally auto-takes qualifying scan signals. Simulation only.
 */

export interface PaperStorage {
  load(): PaperSnapshot | null;
  save(snapshot: PaperSnapshot): void;
  clear(): void;
}

const PAPER_KEY = "cryptoin:paper-account:v1";

export class LocalStoragePaperStore implements PaperStorage {
  load(): PaperSnapshot | null {
    try {
      if (typeof localStorage === "undefined") return null;
      const raw = localStorage.getItem(PAPER_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as PaperSnapshot;
      if (typeof parsed.balance !== "number" || !Array.isArray(parsed.positions)) return null;
      return parsed;
    } catch {
      return null;
    }
  }
  save(snapshot: PaperSnapshot): void {
    try {
      localStorage?.setItem(PAPER_KEY, JSON.stringify(snapshot));
    } catch {
      // quota / private mode — best effort
    }
  }
  clear(): void {
    try {
      localStorage?.removeItem(PAPER_KEY);
    } catch {
      // ignore
    }
  }
}

export class PaperEngine {
  private snapshot: PaperSnapshot;
  private storage: PaperStorage;
  private listeners = new Set<(s: PaperSnapshot) => void>();
  private counted = new Set<string>();

  constructor(config: PaperConfig, storage: PaperStorage = new LocalStoragePaperStore()) {
    this.storage = storage;
    const saved = storage.load();
    this.snapshot =
      saved && saved.config.startingBalance === config.startingBalance
        ? { ...saved, config }
        : emptySnapshot(config);
    for (const p of this.snapshot.positions) {
      if (p.closedAt !== null) this.counted.add(p.id);
    }
  }

  subscribe(listener: (s: PaperSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getSnapshot(): PaperSnapshot {
    return this.snapshot;
  }

  private commit(): void {
    this.snapshot = { ...this.snapshot, updatedAt: Date.now() };
    this.storage.save(this.snapshot);
    for (const l of this.listeners) {
      try {
        l(this.snapshot);
      } catch {
        // ignore listener errors
      }
    }
  }

  equity(marks: Map<string, number>): number {
    let unrealized = 0;
    for (const p of this.snapshot.positions) {
      if (p.closedAt !== null) continue;
      unrealized += unrealizedFor(p, marks.get(p.symbol) ?? NaN);
    }
    return this.snapshot.balance + unrealized;
  }

  /** Current equity + drawdown bookkeeping (call after ticks). */
  touch(marks: Map<string, number>): void {
    const eq = this.equity(marks);
    if (eq > this.snapshot.peakEquity) this.snapshot.peakEquity = eq;
    if (this.snapshot.peakEquity > 0) {
      this.snapshot.maxDrawdownPct = Math.max(
        this.snapshot.maxDrawdownPct,
        ((this.snapshot.peakEquity - eq) / this.snapshot.peakEquity) * 100,
      );
    }
    this.commit();
  }

  open(args: Omit<OpenPaperArgs, "equity" | "config">, marks: Map<string, number>): PaperPosition | null {
    // One open position per symbol — no pyramiding the same coin.
    if (this.snapshot.positions.some((p) => p.symbol === args.symbol && p.closedAt === null)) {
      return null;
    }
    const equity = this.equity(marks);
    const position = openPaperPosition({ ...args, equity, config: this.snapshot.config });
    if (!position) return null;
    this.snapshot.positions = [position, ...this.snapshot.positions];
    this.commit();
    return position;
  }

  /** Apply a mark price to every open position. Returns closed positions. */
  tick(symbol: string, markPrice: number): PaperPosition[] {
    const closed: PaperPosition[] = [];
    for (const p of this.snapshot.positions) {
      if (p.closedAt !== null) continue;
      if (p.symbol !== symbol) continue;
      const wasClosed = applyPaperTick(p, markPrice, this.snapshot.config.feeRate);
      if (wasClosed && p.closedAt !== null && !this.counted.has(p.id)) {
        this.counted.add(p.id);
        this.snapshot.balance += p.realized - p.fees;
        this.snapshot.realizedPnl += p.realized - p.fees;
        this.snapshot.feesPaid += p.fees;
        this.snapshot.closedCount += 1;
        if (p.realized - p.fees > 0) this.snapshot.wins += 1;
        closed.push(p);
      }
    }
    if (closed.length > 0) this.commit();
    return closed;
  }

  close(id: string, markPrice: number, reason: string): boolean {
    const p = this.snapshot.positions.find((x) => x.id === id);
    if (!p || p.closedAt !== null) return false;
    closePaperPosition(p, markPrice, this.snapshot.config.feeRate, reason);
    this.snapshot.balance += p.realized - p.fees;
    this.snapshot.realizedPnl += p.realized - p.fees;
    this.snapshot.feesPaid += p.fees;
    this.snapshot.closedCount += 1;
    if (p.realized - p.fees > 0) this.snapshot.wins += 1;
    this.commit();
    return true;
  }

  reconfigure(config: PaperConfig): boolean {
    // Config changes only on a fresh account (no opens, no history).
    const dirty =
      this.snapshot.positions.length > 0 ||
      this.snapshot.closedCount > 0 ||
      this.snapshot.balance !== this.snapshot.config.startingBalance;
    if (dirty) return false;
    this.snapshot = emptySnapshot(config);
    this.commit();
    return true;
  }

  reset(config: PaperConfig): void {
    this.counted.clear();
    this.snapshot = emptySnapshot(config);
    this.commit();
  }

  // --- Cloud sync seams (no math changes; copy values verbatim) ---

  /** Replace the whole snapshot (initial cloud load). Marks closed ids counted. */
  replaceSnapshot(snap: PaperSnapshot): void {
    this.counted.clear();
    for (const p of snap.positions) {
      if (p.closedAt !== null) this.counted.add(p.id);
    }
    this.snapshot = { ...snap, positions: [...snap.positions] };
    this.commit();
  }

  /** Insert or replace one remote position by id (realtime incremental). */
  mergeRemotePosition(p: PaperPosition): boolean {
    const i = this.snapshot.positions.findIndex((x) => x.id === p.id);
    if (i >= 0) {
      const cur = this.snapshot.positions[i];
      // Closed is terminal — never reopen via remote echo.
      if (cur.closedAt !== null && p.closedAt === null) return false;
      const next = [...this.snapshot.positions];
      next[i] = { ...p };
      this.snapshot.positions = next;
    } else {
      this.snapshot.positions = [{ ...p }, ...this.snapshot.positions];
    }
    if (p.closedAt !== null) this.counted.add(p.id);
    this.commit();
    return true;
  }

  /** Apply authoritative cloud account totals (balance/stats/config only). */
  applyRemoteAccountTotals(next: {
    balance: number;
    realizedPnl: number;
    feesPaid: number;
    closedCount: number;
    wins: number;
    peakEquity: number;
    maxDrawdownPct: number;
    config: PaperConfig;
  }): void {
    this.snapshot = {
      ...this.snapshot,
      balance: next.balance,
      realizedPnl: next.realizedPnl,
      feesPaid: next.feesPaid,
      closedCount: next.closedCount,
      wins: next.wins,
      peakEquity: next.peakEquity,
      maxDrawdownPct: next.maxDrawdownPct,
      config: { ...next.config },
    };
    this.commit();
  }
}
