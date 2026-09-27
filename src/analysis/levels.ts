import type { Swing } from "./swings";

/**
 * Support/resistance zones clustered from swings. Swings within
 * `tolerance` merge into one zone (touch-weighted average price).
 * Zones score on touches (0.5), recency (0.25) and distance (0.25);
 * volume weighting is approximated via candle count when available.
 * Returns nearest + strongest zone per side, or nulls when none qualify.
 */

export interface Level {
  /** Touch-weighted average price of the zone. */
  price: number;
  touches: number;
  /** 0..1 composite strength. */
  strength: number;
}

export interface LevelsResult {
  nearestSupport: Level | null;
  strongSupport: Level | null;
  nearestResistance: Level | null;
  strongResistance: Level | null;
}

interface Zone {
  price: number;
  touches: number;
  lastIndex: number;
}

export function buildLevels(
  swings: Swing[],
  price: number,
  atr: number,
  toleranceAtrMult = 0.5,
): LevelsResult {
  const empty: LevelsResult = {
    nearestSupport: null,
    strongSupport: null,
    nearestResistance: null,
    strongResistance: null,
  };
  if (!Number.isFinite(price) || !Number.isFinite(atr) || atr <= 0) return empty;
  if (swings.length === 0) return empty;
  const tolerance = Math.max(atr * toleranceAtrMult, price * 0.001);

  const cluster = (type: "high" | "low"): Zone[] => {
    const pts = swings.filter((s) => s.type === type).sort((a, b) => a.price - b.price);
    const zones: Zone[] = [];
    for (const p of pts) {
      const z = zones.find((z) => Math.abs(z.price - p.price) <= tolerance);
      if (z) {
        z.price = (z.price * z.touches + p.price) / (z.touches + 1);
        z.touches += 1;
        z.lastIndex = Math.max(z.lastIndex, p.index);
      } else {
        zones.push({ price: p.price, touches: 1, lastIndex: p.index });
      }
    }
    return zones;
  };

  const maxIndex = Math.max(...swings.map((s) => s.index));
  const score = (z: Zone): Level => {
    const distAtr = Math.abs(z.price - price) / atr;
    const touchScore = Math.min(1, z.touches / 3);
    const recency = Math.max(0, 1 - (maxIndex - z.lastIndex) / 120);
    const distScore = Math.max(0, 1 - distAtr / 10);
    return {
      price: z.price,
      touches: z.touches,
      strength: touchScore * 0.5 + recency * 0.25 + distScore * 0.25,
    };
  };

  const supports = cluster("low")
    .map((z) => ({ zone: z, level: score(z) }))
    .filter(({ zone }) => zone.price < price)
    .sort((a, b) => b.zone.price - a.zone.price);
  const resistances = cluster("high")
    .map((z) => ({ zone: z, level: score(z) }))
    .filter(({ zone }) => zone.price > price)
    .sort((a, b) => a.zone.price - b.zone.price);

  const strongest = (list: { level: Level }[]): Level | null => {
    if (list.length === 0) return null;
    return list.reduce((a, b) => (b.level.strength > a.level.strength ? b : a)).level;
  };

  return {
    nearestSupport: supports[0]?.level ?? null,
    strongSupport: strongest(supports),
    nearestResistance: resistances[0]?.level ?? null,
    strongResistance: strongest(resistances),
  };
}
