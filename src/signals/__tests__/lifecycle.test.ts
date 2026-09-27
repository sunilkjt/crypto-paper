import { describe, expect, it } from "vitest";
import { isNoteworthyTransition, nextLifecycleState } from "../lifecycle";

describe("lifecycle", () => {
  it("starts NEW then ACTIVE", () => {
    const base = { previousStrength: null as number | null, strength: 70, price: 100, invalidation: 90, tp3: 120, direction: "LONG" as const };
    expect(nextLifecycleState({ ...base, previous: null })).toBe("NEW");
    expect(nextLifecycleState({ ...base, previous: "NEW", previousStrength: 70 })).toBe("ACTIVE");
  });

  it("tracks STRENGTHENING and WEAKENING on ±5 moves", () => {
    const base = { price: 100, invalidation: 90, tp3: 120, direction: "LONG" as const };
    expect(nextLifecycleState({ ...base, previous: "ACTIVE", previousStrength: 70, strength: 75 })).toBe("STRENGTHENING");
    expect(nextLifecycleState({ ...base, previous: "ACTIVE", previousStrength: 70, strength: 65 })).toBe("WEAKENING");
    expect(nextLifecycleState({ ...base, previous: "ACTIVE", previousStrength: 70, strength: 72 })).toBe("ACTIVE");
  });

  it("invalidates through the stop and completes at TP3", () => {
    expect(
      nextLifecycleState({ previous: "ACTIVE", previousStrength: 70, strength: 70, price: 89, invalidation: 90, tp3: 120, direction: "LONG" }),
    ).toBe("INVALIDATED");
    expect(
      nextLifecycleState({ previous: "ACTIVE", previousStrength: 70, strength: 80, price: 121, invalidation: 90, tp3: 120, direction: "LONG" }),
    ).toBe("COMPLETED");
    expect(
      nextLifecycleState({ previous: "ACTIVE", previousStrength: 70, strength: 70, price: 79, invalidation: 110, tp3: 80, direction: "SHORT" }),
    ).toBe("COMPLETED");
    expect(
      nextLifecycleState({ previous: "ACTIVE", previousStrength: 70, strength: 70, price: 111, invalidation: 110, tp3: 80, direction: "SHORT" }),
    ).toBe("INVALIDATED");
  });

  it("keeps terminal states terminal", () => {
    const base = { previousStrength: 70, strength: 80, price: 100, invalidation: 90, tp3: 120, direction: "LONG" as const };
    expect(nextLifecycleState({ ...base, previous: "INVALIDATED" })).toBe("INVALIDATED");
    expect(nextLifecycleState({ ...base, previous: "COMPLETED" })).toBe("COMPLETED");
  });

  it("flags only material transitions as noteworthy", () => {
    expect(isNoteworthyTransition(null, "NEW")).toBe(true);
    expect(isNoteworthyTransition("ACTIVE", "ACTIVE")).toBe(false);
    expect(isNoteworthyTransition("ACTIVE", "STRENGTHENING")).toBe(true);
    expect(isNoteworthyTransition("ACTIVE", "WEAKENING")).toBe(true);
    expect(isNoteworthyTransition("NEW", "ACTIVE")).toBe(false);
    expect(isNoteworthyTransition("ACTIVE", "INVALIDATED")).toBe(true);
    expect(isNoteworthyTransition("ACTIVE", "COMPLETED")).toBe(true);
  });
});
