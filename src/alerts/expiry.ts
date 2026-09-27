/**
 * Signal expiration. A setup becomes EXPIRED when it outlives its maximum
 * lifetime or its technical structure stops supporting it (strength decayed
 * below the tradable bar). Expired signals never alert again; a genuinely
 * fresh setup mints a new signal ID and starts over.
 */

export const DEFAULT_MAX_SIGNAL_AGE_MS = 24 * 60 * 60 * 1000;
export const EXPIRED_BELOW_STRENGTH = 40;

export function isExpired(args: {
  firstSeen: number;
  strength: number;
  now?: number;
  maxAgeMs?: number;
}): boolean {
  const now = args.now ?? Date.now();
  const maxAge = args.maxAgeMs ?? DEFAULT_MAX_SIGNAL_AGE_MS;
  if (now - args.firstSeen > maxAge) return true;
  if (args.strength < EXPIRED_BELOW_STRENGTH) return true;
  return false;
}
