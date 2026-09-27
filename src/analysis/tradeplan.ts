import type { LevelsResult } from "./levels";
import type { StructureResult } from "./structure";
import type { Direction } from "./scoring";

/**
 * Entry zone, invalidation and take-profits from structure — never from
 * fixed percentages. Invalidation sits where the setup becomes technically
 * invalid (beyond the swing/level that must hold, plus an ATR buffer).
 * TPs step through real levels with minimum R-multiple floors and strict
 * ordering (TP1<TP2<TP3 LONG, mirrored SHORT).
 */

export interface TradePlan {
  entryLow: number;
  entryHigh: number;
  invalidation: number;
  tp1: number;
  tp2: number;
  tp3: number;
  /** Reward:risk measured to the average of the three TPs. */
  riskReward: number;
}

export interface TradePlanInput {
  direction: Exclude<Direction, "WAIT">;
  price: number;
  atr: number;
  levels: LevelsResult;
  structure: StructureResult;
}

const ENTRY_ATR_CAP = 1.0;
const INV_BUFFER_ATR = 0.25;
const MIN_R = [1, 2, 3] as const;

export function buildTradePlan(input: TradePlanInput): TradePlan | null {
  const { direction, price, atr, levels, structure } = input;
  if (![price, atr].every(Number.isFinite) || atr <= 0 || price <= 0) return null;
  return direction === "LONG"
    ? buildLong(price, atr, levels, structure)
    : buildShort(price, atr, levels, structure);
}

function buildLong(
  price: number,
  atr: number,
  levels: LevelsResult,
  structure: StructureResult,
): TradePlan | null {
  const support = levels.nearestSupport?.price ?? structure.lastSwingLow;
  if (support === null || support === undefined) return null;
  // Entry: support up to current price, capped so chasing is bounded.
  const entryLow = support - atr * 0.1;
  const entryHigh = Math.min(price, support + atr * ENTRY_ATR_CAP);
  if (!(entryHigh > entryLow)) return null;
  const entryMid = (entryLow + entryHigh) / 2;

  const swingLow = structure.lastSwingLow;
  const invalidation =
    Math.min(support, swingLow ?? support) - atr * INV_BUFFER_ATR;
  if (!(invalidation < entryLow)) return null;
  const risk = entryMid - invalidation;
  if (!(risk > 0)) return null;

  const res1 = levels.nearestResistance?.price ?? null;
  const res2 = levels.strongResistance?.price ?? structure.lastSwingHigh ?? null;
  const tp1 = Math.max(res1 ?? -Infinity, entryMid + MIN_R[0] * risk);
  const tp2raw = Math.max(res2 ?? -Infinity, entryMid + MIN_R[1] * risk);
  const tp2 = Math.max(tp2raw, tp1 + 0.25 * risk);
  const tp3 = Math.max(tp2 + 0.5 * risk, entryMid + MIN_R[2] * risk);
  return {
    entryLow: r4(entryLow),
    entryHigh: r4(entryHigh),
    invalidation: r4(invalidation),
    tp1: r4(tp1),
    tp2: r4(tp2),
    tp3: r4(tp3),
    riskReward: Math.round(((tp1 + tp2 + tp3) / 3 - entryMid) / risk * 100) / 100,
  };
}

function buildShort(
  price: number,
  atr: number,
  levels: LevelsResult,
  structure: StructureResult,
): TradePlan | null {
  const resistance = levels.nearestResistance?.price ?? structure.lastSwingHigh;
  if (resistance === null || resistance === undefined) return null;
  const entryLow = Math.max(price, resistance - atr * ENTRY_ATR_CAP);
  const entryHigh = resistance + atr * 0.1;
  if (!(entryHigh > entryLow)) return null;
  const entryMid = (entryLow + entryHigh) / 2;

  const swingHigh = structure.lastSwingHigh;
  const invalidation =
    Math.max(resistance, swingHigh ?? resistance) + atr * INV_BUFFER_ATR;
  if (!(invalidation > entryHigh)) return null;
  const risk = invalidation - entryMid;
  if (!(risk > 0)) return null;

  const sup1 = levels.nearestSupport?.price ?? null;
  const sup2 = levels.strongSupport?.price ?? structure.lastSwingLow ?? null;
  const tp1 = Math.min(sup1 ?? Infinity, entryMid - MIN_R[0] * risk);
  const tp2raw = Math.min(sup2 ?? Infinity, entryMid - MIN_R[1] * risk);
  const tp2 = Math.min(tp2raw, tp1 - 0.25 * risk);
  const tp3 = Math.min(tp2 - 0.5 * risk, entryMid - MIN_R[2] * risk);
  return {
    entryLow: r4(entryLow),
    entryHigh: r4(entryHigh),
    invalidation: r4(invalidation),
    tp1: r4(tp1),
    tp2: r4(tp2),
    tp3: r4(tp3),
    riskReward: Math.round((entryMid - (tp1 + tp2 + tp3) / 3) / risk * 100) / 100,
  };
}

function r4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
