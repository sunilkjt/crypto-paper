import type { PaperConfig, PaperPosition, PaperSnapshot } from "./types";

/**
 * Pure paper-portfolio math. Positions progress OPEN → TP1/2/3 HIT on
 * touches, STOPPED through invalidation, CLOSED manually. Partials exit in
 * thirds; R multiples derive from planned risk. No network, no orders.
 */

let seq = 0;

export function paperId(symbol: string): string {
  seq += 1;
  return `paper-${symbol.toUpperCase()}-${Date.now()}-${seq}`;
}

export interface OpenPaperArgs {
  symbol: string;
  timeframe: string;
  setupType: string;
  direction: "LONG" | "SHORT";
  entry: number;
  invalidation: number;
  tp1: number;
  tp2: number;
  tp3: number;
  strength: number;
  equity: number;
  config: PaperConfig;
  at?: number;
}

export function openPaperPosition(args: OpenPaperArgs): PaperPosition | null {
  const stopDist =
    args.direction === "LONG" ? args.entry - args.invalidation : args.invalidation - args.entry;
  if (!(stopDist > 0) || !(args.equity > 0) || !(args.entry > 0)) return null;
  const risk = args.equity * args.config.riskPerTrade;
  const size = risk / stopDist;
  const notional = size * args.entry;
  return {
    id: paperId(args.symbol),
    symbol: args.symbol.toUpperCase(),
    timeframe: args.timeframe,
    setupType: args.setupType,
    direction: args.direction,
    entry: args.entry,
    size,
    notional,
    margin: notional,
    risk,
    invalidation: args.invalidation,
    tp1: args.tp1,
    tp2: args.tp2,
    tp3: args.tp3,
    strength: args.strength,
    status: "OPEN",
    thirdsRemaining: 3,
    realized: 0,
    fees: notional * args.config.feeRate,
    openedAt: args.at ?? Date.now(),
    closedAt: null,
    closeReason: null,
  };
}

function thirdExit(p: PaperPosition, px: number, feeRate: number): void {
  const third = p.size / 3;
  p.realized += (p.direction === "LONG" ? px - p.entry : p.entry - px) * third;
  p.fees += third * px * feeRate;
  p.thirdsRemaining -= 1;
}

/** Apply one mark price; returns true when the position just closed. */
export function applyPaperTick(
  p: PaperPosition,
  markPrice: number,
  feeRate: number,
  at: number = Date.now(),
): boolean {
  if (p.status === "STOPPED" || p.status === "CLOSED" || p.status === "TP3 HIT") return true;
  if (!Number.isFinite(markPrice) || markPrice <= 0) return false;
  const isLong = p.direction === "LONG";
  const stopTouched = isLong ? markPrice <= p.invalidation : markPrice >= p.invalidation;
  // Conservative: stop processed before targets on the same tick.
  if (stopTouched) {
    while (p.thirdsRemaining > 0) {
      const third = p.size / 3;
      p.realized += (isLong ? p.invalidation - p.entry : p.entry - p.invalidation) * third;
      p.fees += third * p.invalidation * feeRate;
      p.thirdsRemaining -= 1;
    }
    p.status = "STOPPED";
    p.closedAt = at;
    p.closeReason = "Invalidation touched.";
    return true;
  }
  const hit = (level: number) => (isLong ? markPrice >= level : markPrice <= level);
  if (p.thirdsRemaining === 3 && hit(p.tp1)) {
    thirdExit(p, p.tp1, feeRate);
    p.status = "TP1 HIT";
  }
  if (p.thirdsRemaining === 2 && hit(p.tp2)) {
    thirdExit(p, p.tp2, feeRate);
    p.status = "TP2 HIT";
  }
  if (p.thirdsRemaining === 1 && hit(p.tp3)) {
    thirdExit(p, p.tp3, feeRate);
    p.status = "TP3 HIT";
    p.closedAt = at;
    p.closeReason = "TP3 touched — full exit.";
    return true;
  }
  return false;
}

export function closePaperPosition(p: PaperPosition, markPrice: number, feeRate: number, reason: string, at: number = Date.now()): void {
  if (p.status === "STOPPED" || p.status === "CLOSED" || p.status === "TP3 HIT") return;
  while (p.thirdsRemaining > 0) {
    const third = p.size / 3;
    p.realized += (p.direction === "LONG" ? markPrice - p.entry : p.entry - markPrice) * third;
    p.fees += third * markPrice * feeRate;
    p.thirdsRemaining -= 1;
  }
  p.status = "CLOSED";
  p.closedAt = at;
  p.closeReason = reason;
}

/** Unrealized PnL on the remaining thirds at mark (fees excluded). */
export function unrealizedFor(p: PaperPosition, markPrice: number): number {
  if (p.status === "STOPPED" || p.status === "CLOSED" || p.status === "TP3 HIT") return 0;
  if (!Number.isFinite(markPrice) || markPrice <= 0) return 0;
  const remaining = (p.size / 3) * p.thirdsRemaining;
  return (p.direction === "LONG" ? markPrice - p.entry : p.entry - markPrice) * remaining;
}

/** R multiple of realized PnL vs planned risk. */
export function realizedR(p: PaperPosition): number {
  if (!(p.risk > 0)) return 0;
  return Math.round(((p.realized - p.fees) / p.risk) * 100) / 100;
}

export function emptySnapshot(config: PaperConfig): PaperSnapshot {
  return {
    config,
    balance: config.startingBalance,
    realizedPnl: 0,
    feesPaid: 0,
    positions: [],
    closedCount: 0,
    wins: 0,
    peakEquity: config.startingBalance,
    maxDrawdownPct: 0,
    updatedAt: Date.now(),
  };
}
