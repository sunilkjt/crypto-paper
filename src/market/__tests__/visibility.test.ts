import { afterEach, describe, expect, it, vi } from "vitest";
import { onVisible, pollAllowed } from "../visibility";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("visibility", () => {
  it("allows polling without a document (node/SSR default)", () => {
    expect(pollAllowed()).toBe(true);
  });

  it("pauses polling in hidden tabs and resumes on visible", () => {
    const listeners = new Map<string, (() => void)[]>();
    let hidden = true;
    vi.stubGlobal("document", {
      get hidden() {
        return hidden;
      },
      addEventListener: (type: string, cb: () => void) => {
        listeners.set(type, [...(listeners.get(type) ?? []), cb]);
      },
      removeEventListener: (type: string, cb: () => void) => {
        listeners.set(type, (listeners.get(type) ?? []).filter((f) => f !== cb));
      },
    });
    expect(pollAllowed()).toBe(false);
    let fired = 0;
    const off = onVisible(() => {
      fired += 1;
    });
    // Still hidden: no callback.
    for (const cb of listeners.get("visibilitychange") ?? []) cb();
    expect(fired).toBe(0);
    // User returns: exactly one refresh nudge.
    hidden = false;
    for (const cb of listeners.get("visibilitychange") ?? []) cb();
    expect(fired).toBe(1);
    off();
    for (const cb of listeners.get("visibilitychange") ?? []) cb();
    expect(fired).toBe(1); // cleaned up
    expect(pollAllowed()).toBe(true);
  });
});
