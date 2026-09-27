/**
 * Tab-visibility helpers. Hidden tabs must not burn API quota or CPU on
 * work nobody sees: polling loops check `pollAllowed()` and skip, and
 * callers refresh once via `onVisible()` when the user returns.
 * The WebSocket stays connected (cheap server push); only polling pauses.
 */

export function isTabHidden(): boolean {
  try {
    if (typeof document === "undefined") return false;
    return document.hidden === true;
  } catch {
    return false;
  }
}

/** False in hidden tabs (node/SSR defaults to true = allowed). */
export function pollAllowed(): boolean {
  return !isTabHidden();
}

export function onVisible(callback: () => void): () => void {
  if (typeof document === "undefined") return () => undefined;
  const handler = () => {
    if (!document.hidden) {
      try {
        callback();
      } catch {
        // listener errors must not break visibility handling
      }
    }
  };
  document.addEventListener("visibilitychange", handler);
  return () => document.removeEventListener("visibilitychange", handler);
}
