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
});
