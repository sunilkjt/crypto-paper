import { MIN_RISK_REWARD } from "../signals/quality";

/**
 * Diagnostic-only rejection taxonomy for the headless scan report.
 * Read-only classification over ALREADY-COMPUTED signal fields — engine
 * criteria are never touched. Priority order is fixed and documented:
 * LOW_SCORE first (below the notify bar nothing else matters), then
 * structural gates in engine-evaluation order.
 */

export type RejectionCode =
  | "LOW_SCORE"
  | "MTF_CONFLICT"
  | "INVALID_RISK_REWARD"
  | "NO_VOLUME_CONFIRMATION"
  | "WAIT_OTHER"
  | "LOW_LIQUIDITY"
  | "UNIVERSE_CAP"
  | "OTHER";

export interface WaitCandidate {
  strength: number;
  minStrength: number;
  mtfConflict: boolean;
  riskReward: number | null;
  volumeLow: boolean;
}

/** Single-bucket reason for one eligible-but-WAIT result. */
export function classifyWait(c: WaitCandidate): RejectionCode {
  if (c.strength < c.minStrength) return "LOW_SCORE";
  if (c.mtfConflict) return "MTF_CONFLICT";
  if (c.riskReward !== null && c.riskReward < MIN_RISK_REWARD) return "INVALID_RISK_REWARD";
  if (c.volumeLow) return "NO_VOLUME_CONFIRMATION";
  return "WAIT_OTHER";
}

/** Normalize an eligibility exclusion reason to a stable code. */
export function classifyExcluded(reason: string): RejectionCode {
  if (reason.startsWith("24h volume")) return "LOW_LIQUIDITY";
  if (reason.startsWith("outside top")) return "UNIVERSE_CAP";
  return "OTHER";
}

export function topReasons(counts: Record<string, number>, n = 5): [string, number][] {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, Math.max(0, n));
}
