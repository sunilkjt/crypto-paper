import { useSyncExternalStore } from "react";

/**
 * AI explanation mode (persisted UI preference — never a trading setting):
 * - "off": no AI calls anywhere; buttons hidden, auto-fetch disabled.
 * - "manual" (default): AI runs only on explicit tap (✨ buttons).
 * - "auto": coin page also auto-explains strong signals (>= threshold).
 * The scanner stays manual-tap in every mode; ticks never trigger calls.
 */

export type AiMode = "off" | "manual" | "auto";

/** Strong-signal bar for automatic explanations (matches STRONG SETUP band). */
export const AI_AUTO_MIN_STRENGTH = 75;

const AI_MODE_KEY = "cryptoin:ai-mode:v1";

const listeners = new Set<() => void>();

let overrideForTests: Storage | null | undefined;

function storage(): Storage | null {
  if (overrideForTests !== undefined) return overrideForTests;
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    return null;
  }
}

/** Test seam: inject an in-memory Storage-like object. */
export function __setAiModeStorageForTests(s: Storage | null): void {
  overrideForTests = s;
}

function readMode(): AiMode {
  try {
    const v = storage()?.getItem(AI_MODE_KEY);
    return v === "off" || v === "auto" ? v : "manual";
  } catch {
    return "manual";
  }
}

export function getAiMode(): AiMode {
  return readMode();
}

export function setAiMode(mode: AiMode): void {
  try {
    storage()?.setItem(AI_MODE_KEY, mode);
  } catch {
    // best effort
  }
  for (const l of listeners) {
    try {
      l();
    } catch {
      // ignore listener errors
    }
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useAiMode(): AiMode {
  return useSyncExternalStore(subscribe, readMode, () => "manual" as AiMode);
}

/** Test seam: clear in-memory listeners (storage itself is origin-scoped). */
export function resetAiModeListenersForTests(): void {
  listeners.clear();
}
