import type { Signal } from "../analysis/signal";

/**
 * Setup-type classification + stable IDs. BOUNCE needs detector agreement;
 * BREAKOUT/BREAKDOWN need a close-confirmed break with non-weak volume
 * (every plain price increase is NOT a breakout); PULLBACK/REVERSAL come
 * from MTF flavors; the rest is trend-following or range noise.
 */

export type SetupType =
  | "BOUNCE"
  | "BREAKOUT"
  | "BREAKDOWN"
  | "PULLBACK"
  | "REVERSAL"
  | "TREND"
  | "RANGE";

export function classifySetupType(signal: Signal): SetupType {
  if (signal.direction === "WAIT") return "RANGE";

  const bounceDir = signal.bounce?.direction;
  if (
    bounceDir !== null &&
    bounceDir !== undefined &&
    bounceDir === signal.direction &&
    (signal.bounce?.bounceScore ?? 0) >= 60
  ) {
    return "BOUNCE";
  }

  // Close-confirmed structural breaks (wicks excluded upstream).
  if (signal.direction === "LONG" && signal.brokeAbove) {
    return signal.volume === "LOW" ? "TREND" : "BREAKOUT";
  }
  if (signal.direction === "SHORT" && signal.brokeBelow) {
    return signal.volume === "LOW" ? "TREND" : "BREAKDOWN";
  }

  const mtf15 = signal.multiTimeframe?.tfs.find((t) => t.timeframe === "15m")?.flavor;
  const mtf5 = signal.multiTimeframe?.tfs.find((t) => t.timeframe === "5m")?.flavor;
  if (mtf15 === "PULLBACK" || mtf15 === "BEAR_RALLY") return "PULLBACK";
  if (
    mtf5 === "BULLISH_REVERSAL" ||
    mtf5 === "BEARISH_REVERSAL" ||
    mtf15 === "BULLISH_REVERSAL" ||
    mtf15 === "BEARISH_REVERSAL"
  ) {
    return "REVERSAL";
  }

  if (signal.direction === "LONG") {
    return signal.marketStructure === "BULLISH" ? "TREND" : "RANGE";
  }
  return signal.marketStructure === "BEARISH" ? "TREND" : "RANGE";
}

/**
 * Stable ID: symbol|direction|timeframe|setupType|anchor.
 * Anchor = signal data timestamp floored to the setup bar, so the ID
 * survives refreshes but changes when fresh structure forms.
 */
export function stableSignalId(args: {
  symbol: string;
  direction: "LONG" | "SHORT";
  timeframe: string;
  setupType: SetupType;
  anchorTimestamp: number;
}): string {
  return [args.symbol.toUpperCase(), args.direction, args.timeframe, args.setupType, args.anchorTimestamp].join("|");
}

export function signalIdFor(signal: Signal, setupType: SetupType): string | null {
  if (signal.direction !== "LONG" && signal.direction !== "SHORT") return null;
  return stableSignalId({
    symbol: signal.symbol,
    direction: signal.direction,
    timeframe: signal.timeframe,
    setupType,
    anchorTimestamp: signal.dataTimestamp,
  });
}
