import type { Candle } from "../../market/hyperliquid/types";

/**
 * Deterministic OHLCV builder from a close series (no randomness).
 * Gapless opens (open == prev close) can never form strict fractals after
 * peaks, so callers may pass a deterministic `gap` added to each open —
 * real markets gap, and tests need genuine swing highs AND lows.
 */
export function candlesFromCloses(
  closes: number[],
  opts?: {
    baseVolume?: number;
    start?: number;
    stepMs?: number;
    gap?: (index: number, prevClose: number) => number;
  },
): Candle[] {
  const baseVolume = opts?.baseVolume ?? 1000;
  const start = opts?.start ?? 1_700_000_000_000;
  const stepMs = opts?.stepMs ?? 900_000;
  return closes.map((c, i) => {
    const o = i === 0 ? c : closes[i - 1] + (opts?.gap ? opts.gap(i, closes[i - 1]) : 0);
    const wiggle = Math.abs(c - o) * 0.3 + c * 0.0005;
    return {
      timestamp: start + i * stepMs,
      open: o,
      high: Math.max(o, c) + wiggle,
      low: Math.min(o, c) - wiggle,
      close: c,
      volume: baseVolume + ((i * 37) % 200),
    };
  });
}

/**
 * Rising staircase: 7 bars up, 3-bar pullback. Pullbacks span enough bars
 * for fractal swings to form genuine HH (peaks) and HL (dips) sequences.
 */
const STAIR_GAP = 0.0012;
export function uptrend(n = 260, start = 100, slope = 0.4): number[] {
  return Array.from({ length: n }, (_, i) => {
    const cyc = i % 10;
    const dip = cyc === 7 ? -slope * 4 : cyc === 8 ? -slope * 5 : cyc === 9 ? -slope * 4 : 0;
    return start + i * slope + dip;
  });
}

/** Gap-down after each staircase peak so swing highs print strictly. */
export function stairGapUp(i: number, prev: number): number {
  const cyc = i % 10;
  if (cyc === 7) return -prev * STAIR_GAP;
  if (cyc === 0 && i > 0) return prev * STAIR_GAP;
  return 0;
}

/** Gap-up after each staircase trough so swing lows print strictly. */
export function stairGapDown(i: number, prev: number): number {
  const cyc = i % 10;
  if (cyc === 7) return prev * STAIR_GAP;
  if (cyc === 0 && i > 0) return -prev * STAIR_GAP;
  return 0;
}

/** Full OHLCV staircase with cycle-aligned gaps (both swing sides form). */
export function trendCandles(dir: "up" | "down", n = 260): Candle[] {
  const closes = dir === "up" ? uptrend(n) : downtrend(n);
  return candlesFromCloses(closes, { gap: dir === "up" ? stairGapUp : stairGapDown });
}

/** Falling staircase: mirror of uptrend (LH/LL sequences). */
export function downtrend(n = 260, start = 200, slope = 0.4): number[] {
  return Array.from({ length: n }, (_, i) => {
    // Ramped dead-cat: small first lift (trough prints), sustained top (top prints).
    const cyc = i % 10;
    const lift = cyc === 7 ? slope * 2 : cyc === 8 ? slope * 5.5 : cyc === 9 ? slope * 6 : 0;
    return start - i * slope + lift;
  });
}

/** Accelerating rally: strong, steepening momentum (RSI/MACD decisive). */
export function rally(n = 260, start = 100): number[] {
  return Array.from({ length: n }, (_, i) => start + 0.05 * Math.pow(i, 1.7));
}

/** Accelerating selloff: mirror of rally. */
export function selloff(n = 260, start = 800): number[] {
  return Array.from({ length: n }, (_, i) => start - 0.05 * Math.pow(i, 1.7));
}

/**
 * Parabolic blowoff: accelerating rally plus a final vertical spike.
 * Price ends far above any support — the textbook chase the extension
 * gate must refuse.
 */
export function parabolic(): number[] {
  const base = rally(250);
  const top = base[base.length - 1];
  return [...base, top * 1.1, top * 1.19, top * 1.3, top * 1.3, top * 1.31];
}

/**
 * Mean-reverting chop ending mid-range on a descending zero-crossing —
 * price sits inside its converged EMA cluster (neutral by construction).
 */
export function sideways(n = 264, mid = 100, amp = 1.5): number[] {
  return Array.from({ length: n }, (_, i) => mid + Math.sin(i / 4) * amp);
}

/** Sharp selloff then V-recovery (oversold → recovering). */
export function vRecovery(): number[] {
  const sell = Array.from({ length: 40 }, (_, i) => 100 - i * 1.2);
  const bounce = Array.from({ length: 30 }, (_, i) => 52 + i * 1.1);
  const drift = Array.from({ length: 200 }, (_, i) => 85 + i * 0.15);
  return [...sell, ...bounce, ...drift];
}

/** Breakout above a flat top that closes back inside (false breakout). */
export function falseBreakoutUp(): number[] {
  const base = Array.from({ length: 200 }, (_, i) => 100 + Math.sin(i / 5) * 0.8);
  const top = Math.max(...base);
  return [...base, top + 1.5, top + 2.0, top - 0.5, top - 1.0, top - 0.8];
}

/**
 * Wick rejection: decline, sharp dip below the floor, snap-back and tight
 * hold just above the dip low — a genuine higher-timeframe-flat rejection.
 */
export function rejectionWick(): number[] {
  const fall = Array.from({ length: 170 }, (_, i) => 100 - i * 0.28);
  const dip = [51.6, 50.2, 49.4];
  const snap = [51.8, 52.4];
  const hold = Array.from({ length: 40 }, (_, i) => 52.4 + Math.sin(i / 2) * 0.25 + i * 0.01);
  return [...fall, ...dip, ...snap, ...hold];
}

/** Long decline into a flat floor with no bounce (downtrend intact). */
export function deadFloor(): number[] {
  const fall = Array.from({ length: 60 }, (_, i) => 100 - i * 0.8);
  const floor = Array.from({ length: 200 }, (_, i) => 52 + Math.sin(i / 3) * 0.4 + i * 0.005);
  return [...fall, ...floor];
}
