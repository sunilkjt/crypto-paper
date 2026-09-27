import { PaperEngine } from "./engine";
import { DEFAULT_PAPER_CONFIG } from "./types";

/**
 * App-wide shared paper engine so the coin page (TAKE PAPER TRADE) and the
 * Paper page operate on the same simulated account. Simulation only.
 */
let shared: PaperEngine | null = null;

export function getSharedPaperEngine(): PaperEngine {
  if (!shared) shared = new PaperEngine(DEFAULT_PAPER_CONFIG);
  return shared;
}

/** Test seam. */
export function resetSharedPaperEngine(): void {
  shared = null;
}
