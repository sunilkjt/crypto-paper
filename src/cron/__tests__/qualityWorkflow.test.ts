import { describe, expect, it } from "vitest";
import workflowSrc from "../../../.github/workflows/signal-quality.yml?raw";

/**
 * Regression guards for the issue-deduplication step. A prior revision
 * passed jq's `-r` flag as a GitHub CLI argument (`--jq -r '.[].title'`),
 * which made every lookup fail — and the failure fell through to creating
 * a duplicate. These guards pin the corrected, failure-explicit shape.
 */
describe("signal-quality workflow dedupe", () => {
  it("passes a valid jq expression (no stray CLI flags)", () => {
    expect(workflowSrc).toContain("--jq '.[].title'");
    expect(workflowSrc).not.toMatch(/--jq -r/);
  });

  it("never treats a failed lookup as proof of absence", () => {
    // Lookup failure aborts creation loudly instead of falling through.
    expect(workflowSrc).toMatch(/if ! gh issue list/);
    expect(workflowSrc).toMatch(/absence unproven/);
  });

  it("matches duplicate signatures literally", () => {
    expect(workflowSrc).toMatch(/grep -qF "\[\$SIG\]"/);
  });

  it("gates issue creation on the drafted file", () => {
    expect(workflowSrc).toContain("hashFiles('reports/issue.json') != ''");
  });

  it("keeps failure visibility (upload + issue steps survive red runs)", () => {
    const alwaysCount = (workflowSrc.match(/if: always\(\)/g) ?? []).length;
    expect(alwaysCount).toBeGreaterThanOrEqual(2);
  });
});
