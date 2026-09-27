import { HIGH_THRESHOLD, NORMAL_THRESHOLD } from "../indicators/volume";

/**
 * Volume regime from relative volume. Direction-agnostic confirmation:
 * identical score feeds both LONG and SHORT sides — volume confirms,
 * it never triggers alone. Null → null (INSUFFICIENT DATA).
 */

export type VolumeLabel = "HIGH" | "NORMAL" | "LOW";

export interface VolumeResult {
  label: VolumeLabel;
  /** 0..1 confirmation strength (same for both directions). */
  score: number;
  spike: boolean;
}

export function classifyVolume(relativeVolume: number | null, spike: boolean): VolumeResult | null {
  if (relativeVolume === null || !Number.isFinite(relativeVolume)) return null;
  if (relativeVolume >= HIGH_THRESHOLD) {
    return { label: "HIGH", score: spike ? 1 : 0.75, spike };
  }
  if (relativeVolume >= NORMAL_THRESHOLD) {
    return { label: "NORMAL", score: 0.5, spike };
  }
  return { label: "LOW", score: 0.15, spike };
}
