import type { PaperConfig, PaperPosition, PaperSnapshot } from "./types";
import { maxNotionalOf, MIN_STOP_DISTANCE_PCT } from "./types";

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

export type PaperOpenErrorCode =
  | "INVALID_PRICE"
  | "INVALID_STOP_SIDE"
  | "STOP_TOO_CLOSE"
  | "INVALID_RISK"
  | "INSUFFICIENT_BALANCE"
  | "INVALID_SIZE"
  | "NOTIONAL_EXCEEDS_MAX";

export interface PaperOpenValidation {
  ok: boolean;
  code: PaperOpenErrorCode | null;
  message: string | null;
  stopDist: number;
  risk: number;
  size: number;
  notional: number;
}

const OPEN_ERRORS: Record<PaperOpenErrorCode, string> = {
  INVALID_PRICE: "Entry price is invalid.",
  INVALID_STOP_SIDE: "Stop loss is on the wrong side of entry for this direction.",
  STOP_TOO_CLOSE: "Stop loss is too close to entry.",
  INVALID_RISK: "Risk configuration is invalid.",
  INSUFFICIENT_BALANCE: "Insufficient available balance.",
  INVALID_SIZE: "Calculated position size is invalid.",
  NOTIONAL_EXCEEDS_MAX: "Position size exceeds the maximum allowed notional.",
};

/**
 * Defensive validation for simulated opens. Pure: never opens, never
 * throws. Every user-actionable failure carries a truthful message so
 * callers never report "already open" for a sizing/validation failure.
 */
export function validatePaperOpen(args: OpenPaperArgs): PaperOpenValidation {
  const fail = (code: PaperOpenErrorCode, stopDist = 0, risk = 0, size = 0, notional = 0): PaperOpenValidation => ({
    ok: false,
    code,
    message: OPEN_ERRORS[code],
    stopDist,
    risk,
    size,
    notional,
  });
  if (!Number.isFinite(args.entry) || args.entry <= 0) return fail("INVALID_PRICE");
  if (!Number.isFinite(args.invalidation) || args.invalidation <= 0) return fail("INVALID_PRICE");
  const stopDist =
    args.direction === "LONG" ? args.entry - args.invalidation : args.invalidation - args.entry;
  if (!(stopDist > 0) || !Number.isFinite(stopDist)) return fail("INVALID_STOP_SIDE");
  if (stopDist / args.entry < MIN_STOP_DISTANCE_PCT) return fail("STOP_TOO_CLOSE", stopDist);
  if (!Number.isFinite(args.equity) || args.equity <= 0) return fail("INSUFFICIENT_BALANCE", stopDist);
  const riskPct = args.config.riskPerTrade;
  if (!Number.isFinite(riskPct) || riskPct <= 0 || riskPct > 1) return fail("INVALID_RISK", stopDist);
  const risk = args.equity * riskPct;
  if (!Number.isFinite(risk) || risk <= 0) return fail("INVALID_RISK", stopDist);
  const size = risk / stopDist;
  if (!Number.isFinite(size) || size <= 0) return fail("INVALID_SIZE", stopDist, risk);
  const notional = size * args.entry;
  if (!Number.isFinite(notional) || notional <= 0) return fail("INVALID_SIZE", stopDist, risk, size);
  const maxNotional = args.equity * maxNotionalOf(args.config);
  if (notional > maxNotional) return fail("NOTIONAL_EXCEEDS_MAX", stopDist, risk, size, notional);
  return { ok: true, code: null, message: null, stopDist, risk, size, notional };
}

export function openPaperPosition(args: OpenPaperArgs): PaperPosition | null {
  const checked = validatePaperOpen(args);
  if (!checked.ok) return null;
  const risk = args.equity * args.config.riskPerTrade;
  const size = risk / checked.stopDist;
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
