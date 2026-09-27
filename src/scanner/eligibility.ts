import type { Market } from "../market/hyperliquid/types";

/**
 * Scan eligibility: configurable, honest counts. Markets failing any gate
 * are excluded with a reason — never force-scored, never fabricated.
 */

export interface EligibilityConfig {
  /** Minimum 24h notional volume in USD. */
  minVolumeNotional: number;
  /** Maximum universe size after volume ranking. */
  universeSize: number;
}

export const DEFAULT_ELIGIBILITY: EligibilityConfig = {
  minVolumeNotional: 250_000,
  universeSize: 40,
};

export interface EligibleMarket {
  market: Market;
}

export interface ExcludedMarket {
  symbol: string;
  reason: string;
}

export interface EligibilityResult {
  eligible: Market[];
  excluded: ExcludedMarket[];
}

/** Pre-fetch gates: volume floor + universe cap by volume rank. */
export function applyEligibility(
  markets: Market[],
  config: EligibilityConfig,
): EligibilityResult {
  const excluded: ExcludedMarket[] = [];
  const candidates = markets.filter((m) => {
    if ((m.dayVolumeNotional ?? 0) < config.minVolumeNotional) {
      excluded.push({ symbol: m.symbol, reason: `24h volume below $${config.minVolumeNotional.toLocaleString()}` });
      return false;
    }
    return true;
  });
  candidates.sort((a, b) => (b.dayVolumeNotional ?? 0) - (a.dayVolumeNotional ?? 0));
  const eligible = candidates.slice(0, config.universeSize);
  for (const m of candidates.slice(config.universeSize)) {
    excluded.push({ symbol: m.symbol, reason: `outside top-${config.universeSize} by volume` });
  }
  return { eligible, excluded };
}
