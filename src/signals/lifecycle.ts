/**
 * Signal lifecycle state machine. States advance only on observed evidence
 * across scans — never one alert per refresh. Transitions:
 * NEW → ACTIVE → {STRENGTHENING | WEAKENING} → {ACTIVE | INVALIDATED | COMPLETED}
 * INVALIDATED/COMPLETED are terminal (a fresh setup mints a new ID).
 */

export type SignalLifecycleState =
  | "NEW"
  | "ACTIVE"
  | "STRENGTHENING"
  | "WEAKENING"
  | "INVALIDATED"
  | "COMPLETED";

export interface LifecycleInput {
  previous: SignalLifecycleState | null;
  previousStrength: number | null;
  strength: number;
  /** Current mark price for invalidation/TP checks (null = unknown). */
  price: number | null;
  invalidation: number | null;
  tp3: number | null;
  direction: "LONG" | "SHORT";
}

export const STRENGTH_DELTA = 5;

export function nextLifecycleState(input: LifecycleInput): SignalLifecycleState {
  const { previous, previousStrength, strength, price, invalidation, tp3, direction } = input;

  // Terminal evidence first — price speaks loudest.
  if (price !== null && invalidation !== null) {
    const dead =
      direction === "LONG" ? price <= invalidation : price >= invalidation;
    if (dead) return "INVALIDATED";
  }
  if (price !== null && tp3 !== null) {
    const done = direction === "LONG" ? price >= tp3 : price <= tp3;
    if (done) return "COMPLETED";
  }

  if (previous === null) return "NEW";
  if (previous === "INVALIDATED" || previous === "COMPLETED") return previous;
  if (previous === "NEW") return "ACTIVE";
  if (previousStrength === null) return "ACTIVE";
  if (strength >= previousStrength + STRENGTH_DELTA) return "STRENGTHENING";
  if (strength <= previousStrength - STRENGTH_DELTA) return "WEAKENING";
  return "ACTIVE";
}

/** A state change worth notifying about (not every refresh). */
export function isNoteworthyTransition(
  from: SignalLifecycleState | null,
  to: SignalLifecycleState,
): boolean {
  if (from === to) return false;
  if (to === "NEW" || to === "INVALIDATED" || to === "COMPLETED") return true;
  if (to === "STRENGTHENING" || to === "WEAKENING") return true;
  return false;
}
