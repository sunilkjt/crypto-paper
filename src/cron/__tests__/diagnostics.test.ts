import { describe, expect, it } from "vitest";
import { classifyExcluded, classifyWait, topReasons } from "../diagnostics";

describe("rejection taxonomy (diagnostic-only, engine untouched)", () => {
  it("prioritizes LOW_SCORE, then structure, then plan, then volume", () => {
    const base = { strength: 80, minStrength: 70, mtfConflict: false, riskReward: 2, volumeLow: false };
    expect(classifyWait(base)).toBe("WAIT_OTHER");
    expect(classifyWait({ ...base, strength: 60 })).toBe("LOW_SCORE");
    expect(classifyWait({ ...base, mtfConflict: true })).toBe("MTF_CONFLICT");
    expect(classifyWait({ ...base, strength: 60, mtfConflict: true })).toBe("LOW_SCORE");
    expect(classifyWait({ ...base, riskReward: 1.2 })).toBe("INVALID_RISK_REWARD");
    expect(classifyWait({ ...base, riskReward: null, volumeLow: true })).toBe("NO_VOLUME_CONFIRMATION");
  });

  it("normalizes eligibility exclusions without touching gates", () => {
    expect(classifyExcluded("24h volume below $250,000")).toBe("LOW_LIQUIDITY");
    expect(classifyExcluded("outside top-60 by volume")).toBe("UNIVERSE_CAP");
    expect(classifyExcluded("something else entirely")).toBe("OTHER");
  });

  it("ranks top reasons deterministically", () => {
    expect(topReasons({ B: 1, A: 1, C: 5 }, 2)).toEqual([
      ["C", 5],
      ["A", 1],
    ]);
    expect(topReasons({}, 3)).toEqual([]);
  });
});
