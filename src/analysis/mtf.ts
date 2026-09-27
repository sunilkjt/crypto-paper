import type { Timeframe } from "../market/hyperliquid/types";
import type { TrendLabel } from "./trend";

/**
 * Multi-timeframe engine. 4H = major trend, 1H = structure, 15M = setup,
 * 5M = entry confirmation. Each TF contributes trend agreement weighted
 * toward the higher frames; strong cross-TF conflict halves the MTF
 * contribution and raises a warning. Missing TFs renormalize with a warning
 * instead of inventing alignment.
 */

export const MTF_ORDER: Timeframe[] = ["4h", "1h", "15m", "5m"];

const TF_WEIGHT: Record<Timeframe, number> = {
  "4h": 0.4,
  "1h": 0.3,
  "15m": 0.2,
  "1m": 0,
  "5m": 0.1,
};

export type SetupFlavor =
  | "BULLISH"
  | "BEARISH"
  | "PULLBACK"
  | "BEAR_RALLY"
  | "BULLISH_REVERSAL"
  | "BEARISH_REVERSAL"
  | "CONTINUATION"
  | "RANGE"
  | "INSUFFICIENT";

export interface TfAssessment {
  timeframe: Timeframe;
  trend: TrendLabel | null;
  /** −1 (full bear) .. +1 (full bull). Null when TF unusable. */
  agreement: number | null;
  flavor: SetupFlavor;
}

export interface MtfResult {
  tfs: TfAssessment[];
  /** 0..1 long-side MTF score (post conflict penalty). */
  longScore: number;
  /** 0..1 short-side MTF score (post conflict penalty). */
  shortScore: number;
  conflict: boolean;
  warnings: string[];
}

export interface TfTrendInput {
  trend: TrendLabel | null;
  bullPoints: number;
  bearPoints: number;
  /** Reversal hint from momentum (recovering/fading) on this TF. */
  reversalUp: boolean;
  reversalDown: boolean;
}

function agreementOf(input: TfTrendInput): number | null {
  if (!input.trend) return null;
  return (input.bullPoints - input.bearPoints) / 5;
}

export function analyzeMtf(
  inputs: Partial<Record<Timeframe, TfTrendInput>>,
): MtfResult {
  const warnings: string[] = [];
  const tfs: TfAssessment[] = MTF_ORDER.map((tf) => {
    const input = inputs[tf];
    if (!input || !input.trend) {
      return { timeframe: tf, trend: null, agreement: null, flavor: "INSUFFICIENT" as SetupFlavor };
    }
    const agreement = agreementOf(input);
    return { timeframe: tf, trend: input.trend, agreement, flavor: "RANGE" as SetupFlavor };
  });

  // Higher-frame flavors mirror their trend agreement directly.
  for (const tf of ["4h", "1h"] as Timeframe[]) {
    const t = tfs.find((x) => x.timeframe === tf);
    if (t && t.agreement !== null) {
      t.flavor = t.agreement > 0.4 ? "BULLISH" : t.agreement < -0.4 ? "BEARISH" : "RANGE";
    }
  }

  // Setup/entry flavors on the lower frames, read against 1H context.
  const h1 = tfs.find((t) => t.timeframe === "1h");
  const m15 = tfs.find((t) => t.timeframe === "15m");
  const m5 = tfs.find((t) => t.timeframe === "5m");
  const h1Bull = (h1?.agreement ?? 0) > 0.2;
  const h1Bear = (h1?.agreement ?? 0) < -0.2;

  if (m15 && m15.agreement !== null) {
    const a = m15.agreement;
    const revUp = inputs["15m"]?.reversalUp ?? false;
    const revDown = inputs["15m"]?.reversalDown ?? false;
    m15.flavor =
      a > 0.4 ? "BULLISH"
      : a < -0.4 ? "BEARISH"
      : h1Bull && a <= 0.2 ? "PULLBACK"
      : h1Bear && a >= -0.2 ? "BEAR_RALLY"
      : revUp ? "BULLISH_REVERSAL"
      : revDown ? "BEARISH_REVERSAL"
      : "RANGE";
  }
  if (m5 && m5.agreement !== null) {
    const a = m5.agreement;
    const revUp = inputs["5m"]?.reversalUp ?? false;
    const revDown = inputs["5m"]?.reversalDown ?? false;
    m5.flavor =
      revUp && a >= -0.2 ? "BULLISH_REVERSAL"
      : revDown && a <= 0.2 ? "BEARISH_REVERSAL"
      : a > 0.4 ? "CONTINUATION"
      : a < -0.4 ? "BEARISH"
      : "RANGE";
  }

  let long = 0;
  let short = 0;
  let weightSum = 0;
  for (const t of tfs) {
    if (t.agreement === null) {
      warnings.push(`${t.timeframe} unavailable — excluded from MTF score.`);
      continue;
    }
    const w = TF_WEIGHT[t.timeframe];
    weightSum += w;
    long += Math.max(0, t.agreement) * w;
    short += Math.max(0, -t.agreement) * w;
  }
  if (weightSum > 0) {
    long /= weightSum;
    short /= weightSum;
  }

  // Strong conflict: any TF firmly against the leading side halves MTF.
  const leadingLong = long >= short;
  const conflict = tfs.some((t) =>
    t.agreement === null
      ? false
      : leadingLong
        ? t.agreement < -0.6
        : t.agreement > 0.6,
  );
  if (conflict) {
    long *= 0.5;
    short *= 0.5;
    warnings.push("Timeframes conflict strongly — MTF score halved.");
  }

  return { tfs, longScore: long, shortScore: short, conflict, warnings };
}
