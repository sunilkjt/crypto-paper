import type { Candle } from "../market/hyperliquid/types";

/**
 * Deterministic fractal swing detection. Bar i is a swing high when its
 * high strictly exceeds every high in [i−strength, i+strength] (mirrored
 * for lows). Only completed swings are returned (no forming right edge
 * beyond the last candle). Bounded by `lookback` most-recent bars.
 */

export interface Swing {
  index: number;
  timestamp: number;
  price: number;
  type: "high" | "low";
}

export function detectSwings(
  candles: Candle[],
  strength = 3,
  lookback = 120,
): Swing[] {
  if (!Number.isInteger(strength) || strength < 1) return [];
  if (candles.length < strength * 2 + 1) return [];
  const start = Math.max(0, candles.length - lookback);
  const out: Swing[] = [];
  // Last `strength` bars cannot be confirmed swings (right edge incomplete).
  const end = candles.length - strength;
  for (let i = Math.max(start + strength, strength); i < end; i++) {
    const h = candles[i].high;
    const l = candles[i].low;
    let isHigh = true;
    let isLow = true;
    for (let j = i - strength; j <= i + strength; j++) {
      if (j === i) continue;
      if (candles[j].high >= h) isHigh = false;
      if (candles[j].low <= l) isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) {
      out.push({ index: i, timestamp: candles[i].timestamp, price: h, type: "high" });
    } else if (isLow) {
      out.push({ index: i, timestamp: candles[i].timestamp, price: l, type: "low" });
    }
  }
  return out;
}
