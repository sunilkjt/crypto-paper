/**
 * Volume confirmation helpers. Relative volume = current / average of the
 * prior `lookback` bars (current bar excluded, so a forming spike is not
 * diluted by itself). Volume is confirmation, never a standalone signal.
 */

export const VOLUME_LOOKBACK = 20;
export const SPIKE_THRESHOLD = 2.0;
export const HIGH_THRESHOLD = 1.5;
export const NORMAL_THRESHOLD = 0.7;

export interface VolumeStats {
  current: number;
  average: number;
  relative: number;
  spike: boolean;
}

export function volumeStats(volumes: number[], lookback = VOLUME_LOOKBACK): VolumeStats | null {
  if (!Number.isInteger(lookback) || lookback < 2) return null;
  if (volumes.length < lookback + 1) return null;
  const prior = volumes.slice(volumes.length - lookback - 1, volumes.length - 1);
  if (prior.some((v) => !Number.isFinite(v) || v < 0)) return null;
  const current = volumes[volumes.length - 1];
  if (!Number.isFinite(current) || current < 0) return null;
  const average = prior.reduce((a, b) => a + b, 0) / prior.length;
  if (average <= 0) return null;
  const relative = current / average;
  return { current, average, relative, spike: relative >= SPIKE_THRESHOLD };
}
