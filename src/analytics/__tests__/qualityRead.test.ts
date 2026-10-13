import { describe, expect, it } from "vitest";
import {
  extractPostgrestError,
  formatNetworkFailure,
  formatRestFailure,
  parseCount,
  redactSensitiveText,
  requireCount,
  requireRows,
} from "../qualityRead";

describe("parseCount", () => {
  it("reads PostgREST totals from Content-Range", () => {
    expect(parseCount("0-0/123")).toBe(123);
    expect(parseCount("0-99/1000")).toBe(1000);
    expect(parseCount("*/0")).toBe(0);
    expect(parseCount(null)).toBeNull();
    expect(parseCount("garbage")).toBeNull();
  });
});

describe("extractPostgrestError", () => {
  it("pulls code/message/hint/details from error objects", () => {
    const err = extractPostgrestError({
      code: "PGRST116",
      message: "JWT expired",
      hint: "check secret",
      details: "d",
    });
    expect(err).toEqual({ code: "PGRST116", message: "JWT expired", hint: "check secret", details: "d" });
  });

  it("returns nulls for arrays, nulls and non-objects", () => {
    expect(extractPostgrestError([])).toEqual({ code: null, message: null, hint: null, details: null });
    expect(extractPostgrestError(null)).toEqual({ code: null, message: null, hint: null, details: null });
    expect(extractPostgrestError("oops")).toEqual({ code: null, message: null, hint: null, details: null });
  });
});

describe("formatRestFailure", () => {
  it("exposes HTTP status, PostgREST fields, operation and query", () => {
    const msg = formatRestFailure("history-count-total", "signal_history?select=id&limit=1", {
      status: 401,
      json: { code: "PGRST301", message: "JWT expired", hint: null, details: null },
      contentRange: null,
    });
    expect(msg).toContain("history-count-total");
    expect(msg).toContain("HTTP 401");
    expect(msg).toContain("PGRST301");
    expect(msg).toContain("JWT expired");
    expect(msg).toContain("signal_history?select=id");
  });

  it("describes successful-shape mismatches without secrets", () => {
    const msg = formatRestFailure("history-rows", "signal_history?select=*", {
      status: 200,
      json: { code: "x", message: "y" },
      contentRange: "0-9/10",
    });
    expect(msg).toContain("history-rows");
    expect(msg).toContain("HTTP 200");
    expect(msg).not.toMatch(/apikey|authorization|bearer/i);
  });

  it("redacts credentials even if a backend echoes them", () => {
    const msg = formatRestFailure("op", "signal_history?select=id", {
      status: 500,
      json: { message: "bearer abc123 and sb_secret_xyz failed" },
      contentRange: null,
    });
    expect(msg).not.toContain("abc123");
    expect(msg).not.toContain("sb_secret_xyz");
    expect(msg).toContain("[redacted]");
  });
});

describe("redactSensitiveText", () => {
  it("redacts keys, tokens and JWTs", () => {
    expect(redactSensitiveText("apikey: secret123")).toContain("[redacted]");
    expect(redactSensitiveText("Authorization: Bearer abc.def.ghi")).not.toContain("abc.def.ghi");
    expect(redactSensitiveText("key sb_secret_abc123")).not.toContain("sb_secret_abc123");
    expect(redactSensitiveText("plain diagnostic")).toBe("plain diagnostic");
  });
});

describe("formatNetworkFailure", () => {
  it("wraps timeouts and DNS errors with operation context", () => {
    const msg = formatNetworkFailure("history-rows", "signal_history?select=*", new Error("fetch failed"));
    expect(msg).toContain("history-rows");
    expect(msg).toContain("fetch failed");
    expect(msg).toContain("signal_history");
  });
});

describe("requireCount / requireRows", () => {
  it("returns counts and rows on successful reads", () => {
    expect(
      requireCount("total", "signal_history?select=id", { status: 200, json: [], contentRange: "0-0/42" }),
    ).toBe(42);
    const rows = requireRows("rows", "signal_history?select=*", {
      status: 200,
      json: [{ id: "a" }],
      contentRange: null,
    });
    expect(rows).toHaveLength(1);
  });

  it("throws log-safe errors instead of returning zero/empty on failure", () => {
    // Failed count must throw — callers map this to DB_UNREADABLE, never to 0.
    expect(() =>
      requireCount("total", "signal_history?select=id", { status: 401, json: { message: "bad jwt" }, contentRange: null }),
    ).toThrow(/HTTP 401/);
    // Missing Content-Range on a 200 is also a failure, not a zero.
    expect(() =>
      requireCount("total", "signal_history?select=id", { status: 200, json: [], contentRange: null }),
    ).toThrow(/failed/);
    // Non-array bodies are failures, not empty history.
    expect(() =>
      requireRows("rows", "signal_history?select=*", { status: 200, json: { message: "x" }, contentRange: null }),
    ).toThrow(/failed/);
    expect(() =>
      requireRows("rows", "signal_history?select=*", { status: 500, json: null, contentRange: null }),
    ).toThrow(/HTTP 500/);
  });
});
