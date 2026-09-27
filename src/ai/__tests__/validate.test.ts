import { describe, expect, it } from "vitest";
import { validateAiResponse } from "../validate";
import { AiInvalidResponseError } from "../types";

function valid(direction: string = "WAIT") {
  return {
    summary: "s",
    marketStructure: "ms",
    setup: "st",
    confirmations: ["c1"],
    conflicts: [],
    risks: ["r1"],
    invalidation: "inv",
    catalysts: [],
    conclusion: "WAIT, no trade.",
    directionEcho: direction,
  };
}

describe("validateAiResponse", () => {
  it("accepts a well-formed response and stamps metadata", () => {
    const out = validateAiResponse(valid("WAIT"), {
      direction: "WAIT",
      provider: "local-explainer",
      marketDataTimestamp: 123,
    });
    expect(out.directionEcho).toBe("WAIT");
    expect(out.provider).toBe("local-explainer");
    expect(out.marketDataTimestamp).toBe(123);
    expect(out.confirmations).toEqual(["c1"]);
  });

  it("REJECTS an AI attempt to override LONG/SHORT/WAIT", () => {
    expect(() =>
      validateAiResponse(valid("LONG"), {
        direction: "WAIT",
        provider: "x",
        marketDataTimestamp: 1,
      }),
    ).toThrow(AiInvalidResponseError);
    expect(() =>
      validateAiResponse(valid("SHORT"), {
        direction: "LONG",
        provider: "x",
        marketDataTimestamp: 1,
      }),
    ).toThrow(AiInvalidResponseError);
  });

  it("drops invented numeric fields and rejects missing text", () => {
    const withJunk = { ...valid("WAIT"), price: 99999, rsi: 12, entry: 1.5 };
    const out = validateAiResponse(withJunk, { direction: "WAIT", provider: "x", marketDataTimestamp: 1 });
    expect(out).not.toHaveProperty("price");
    expect(out).not.toHaveProperty("rsi");
    expect(out).not.toHaveProperty("entry");
    expect(() => validateAiResponse({ ...valid("WAIT"), summary: "" }, { direction: "WAIT", provider: "x", marketDataTimestamp: 1 })).toThrow(
      AiInvalidResponseError,
    );
    expect(() => validateAiResponse({ ...valid("WAIT"), confirmations: "yes" }, { direction: "WAIT", provider: "x", marketDataTimestamp: 1 })).toThrow(
      AiInvalidResponseError,
    );
  });

  it("rejects non-objects and escapes HTML", () => {
    expect(() => validateAiResponse(null, { direction: "WAIT", provider: "x", marketDataTimestamp: 1 })).toThrow(AiInvalidResponseError);
    expect(() => validateAiResponse("<p>hi</p>", { direction: "WAIT", provider: "x", marketDataTimestamp: 1 })).toThrow(AiInvalidResponseError);
    const out = validateAiResponse(
      { ...valid("WAIT"), summary: "<script>alert(1)</script>" },
      { direction: "WAIT", provider: "x", marketDataTimestamp: 1 },
    );
    expect(out.summary).not.toContain("<script>");
  });

  it("system prompt forbids invention and overrides", async () => {
    const { SYSTEM_PROMPT } = await import("../prompts");
    for (const phrase of [
      "NEVER invent",
      "NEVER change the signal direction",
      "as a probability",
      "signalDirection is WAIT",
      "No significant verified recent catalyst found",
    ]) {
      expect(SYSTEM_PROMPT).toContain(phrase);
    }
  });
});
