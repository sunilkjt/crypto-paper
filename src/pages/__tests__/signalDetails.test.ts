import { describe, expect, it } from "vitest";
import modalSrc from "../../components/SignalDetails.tsx?raw";
import pageSrc from "../Performance.tsx?raw";

/**
 * Historical signal viewer guards. The details view is a READ-ONLY window
 * onto stored signal_history rows: it must display stored fields, never
 * regenerate the signal, never determine outcomes, and stay reachable +
 * dismissible (deep link + back + Escape).
 */
describe("signal details viewer", () => {
  it("modal renders the complete stored record", () => {
    for (const needle of [
      "ID", "Symbol", "Category", "Direction", "Score", "Timeframe",
      "Setup", "Quality", "Entry type", "Entry low", "Entry high",
      "Stop / invalidation", "TP1", "TP2", "TP3", "R:R",
      "Signal time", "Last seen", "Outcome", "Realized R",
      "Activation price", "Activation time", "Outcome time", "Resolved at",
      "Ambiguous bar", "Exit path", "Stored record",
    ]) {
      expect(modalSrc).toContain(needle);
    }
  });

  it("modal shows the outcome timeline incl. OPEN awaiting state", () => {
    for (const needle of ["Outcome path", "SIGNAL", "ACTIVATION", "FINAL OUTCOME", "Awaiting resolution"]) {
      expect(modalSrc).toContain(needle);
    }
    // OPEN verdicts are displayed, never upgraded: no verdict assignment.
    expect(modalSrc).not.toMatch(/verdict\s*=\s*"(WIN|LOSS|BREAKEVEN)"/);
  });

  it("modal performs zero outcome mathematics", () => {
    for (const banned of ["replayThirds", "trackOutcome", "buildSignal", "calculateSignalScore", "decideRowAction"]) {
      expect(modalSrc).not.toContain(banned);
    }
    // Chart + cached fetch reuse only.
    expect(modalSrc).toContain("CandleChart");
    expect(modalSrc).toContain("getCachedCandles");
  });

  it("modal separates live market data from the stored record", () => {
    expect(modalSrc).toContain("not part of the stored record");
    expect(modalSrc).toContain("only the resolver determines the official outcome");
    expect(modalSrc).toContain("role=\"dialog\"");
    expect(modalSrc).toContain("Escape");
  });

  it("modal distinguishes RETEST activation from MARKET entry", () => {
    expect(modalSrc).toContain("WAIT FOR RETEST");
    expect(modalSrc).toContain("actual activation/touch");
  });
});

describe("performance recent-results row wiring", () => {
  it("every row is clickable with an explicit affordance", () => {
    expect(pageSrc).toMatch(/role="button"/);
    expect(pageSrc).toContain("View <span");
    expect(pageSrc).toMatch(/openSignal\(r\.id\)/);
  });

  it("symbol navigates to live analysis without opening the modal", () => {
    expect(pageSrc).toMatch(/stopPropagation/);
    expect(pageSrc).toContain("/coin/${r.symbol}");
  });

  it("selection deep-links via ?signal= and back closes it", () => {
    expect(pageSrc).toMatch(/useSearchParams/);
    expect(pageSrc).toMatch(/searchParams\.get\("signal"\)/);
    expect(pageSrc).toMatch(/setSearchParams\(\{\}\)/);
    expect(pageSrc).toContain("SignalDetailsModal");
  });

  it("modal shows stored (not recalculated) outcome and R", () => {
    expect(pageSrc).toContain("signal={selected}");
    expect(pageSrc).toContain("liveMark={marks.get(selected.symbol)");
  });
});
