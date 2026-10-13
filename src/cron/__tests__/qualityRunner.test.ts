import { describe, expect, it } from "vitest";
import runnerSrc from "../../../scripts/signal-quality-test.ts?raw";

/**
 * Safety guards for the continuous-testing runner. It may DETECT and
 * REPORT — never tune, never write signals, never touch the strategy.
 * Comment-stripped: documentation mentions don't count, mechanisms do.
 */
const code = runnerSrc
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

describe("signal-quality runner safety", () => {
  it("never imports the strategy engine", () => {
    expect(code).not.toMatch(/analysis\/signal/);
    expect(code).not.toMatch(/scanner\/engine/);
    expect(code).not.toMatch(/analysis\/hooks/);
    expect(code).not.toMatch(/GROQ|GEMINI|gsk_/);
  });

  it("never writes to Supabase (GET reads only)", () => {
    expect(code).not.toMatch(/"PATCH"/);
    expect(code).not.toMatch(/"DELETE"/);
    expect(code).not.toMatch(/"PUT"/);
    // The only POST in this file would be a violation: delivery goes
    // through the tested TelegramSender, issue creation via gh in CI.
    expect(code).not.toMatch(/method: "POST"/);
  });

  it("only writes report artifacts", () => {
    expect(code).toMatch(/signal-quality\.json/);
    expect(code).toMatch(/signal-quality\.md/);
    // No dotenv-style file loading (env comes from the CI environment only).
    expect(code).not.toMatch(/dotenv/);
    expect(code).not.toMatch(/readFileSync/);
  });

  it("exits loudly on critical status and usage errors", () => {
    expect(code).toMatch(/process\.exit\(1\)/);
    expect(code).toMatch(/process\.exit\(2\)/);
  });

  it("requires every signal-history read (never treats a failed query as zero)", () => {
    // Strict readers throw on non-200/206 or missing Content-Range; the
    // runner must route EVERY count/row read through them.
    expect(code).toMatch(/requireCount\(/);
    expect(code).toMatch(/requireRows\(/);
    expect(code).toMatch(/readCount/);
    // The old silent-parser pattern (countOf + "?? 0") must never return.
    expect(code).not.toMatch(/countOf/);
    // No raw status gate may bypass the helpers (the 206 bug).
    expect(code).not.toMatch(/\.status\s*!==\s*200/);
    expect(code).not.toMatch(/\.status\s*===\s*200/);
  });

  it("logs the underlying database failure without secrets", () => {
    expect(code).toMatch(/db-read FAILED/);
    expect(code).toMatch(/db-read counts ok/);
    expect(code).toMatch(/formatRestFailure/);
    expect(code).toMatch(/formatNetworkFailure/);
    // Diagnostic plumbing must not reference credential holders.
    expect(code).not.toMatch(/console\.(log|error)\([^)]*serviceKey/);
    expect(code).not.toMatch(/console\.(log|error)\([^)]*botToken/);
  });
});
