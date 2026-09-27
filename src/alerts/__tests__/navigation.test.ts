import { describe, expect, it } from "vitest";
import { alertCoinNavigation, isNavigableAlert, isNavigableSymbol } from "../navigation";
import type { SignalEvent } from "../events";

function base(over: Partial<SignalEvent> = {}): SignalEvent {
  return {
    id: "OP|LONG|15m|BOUNCE|1::NEW_SIGNAL",
    type: "NEW_SIGNAL",
    symbol: "OP",
    direction: "LONG",
    setupType: "BOUNCE",
    timeframe: "15m",
    previousStrength: null,
    currentStrength: 82,
    detail: null,
    status: "NEW",
    timestamp: 1700000000000,
    signal: {} as SignalEvent["signal"],
    watched: false,
    read: false,
    ...over,
  };
}

describe("alert navigation", () => {
  it("routes BTC, ETH and other Hyperliquid markets to their coin pages", () => {
    for (const symbol of ["BTC", "ETH", "SOL", "OP", "HYPE", "xyz:XYZ100"]) {
      const nav = alertCoinNavigation(base({ symbol }));
      expect(nav.path).toBe(`/coin/${symbol}`);
      expect(nav.state?.fromAlert.direction).toBe("LONG");
      expect(nav.state?.fromAlert.strength).toBe(82);
      expect(nav.state?.fromAlert.timestamp).toBe(1700000000000);
    }
  });

  it("uses the project's existing route format (no new routes)", () => {
    expect(alertCoinNavigation(base({ symbol: "BTC" })).path).toBe("/coin/BTC");
    expect(alertCoinNavigation(base({ symbol: "ETH" })).path).toBe("/coin/ETH");
    expect(alertCoinNavigation(base({ symbol: "SOL" })).path).toBe("/coin/SOL");
  });

  it("refuses missing or blank symbols (non-clickable rows)", () => {
    for (const bad of ["", "   ", null, undefined, 42]) {
      expect(isNavigableAlert({ symbol: bad } as unknown as SignalEvent)).toBe(false);
      expect(alertCoinNavigation(base({ symbol: bad as unknown as string })).path).toBeNull();
    }
    expect(isNavigableAlert(null)).toBe(false);
    expect(isNavigableAlert(undefined)).toBe(false);
    expect(isNavigableSymbol("a".repeat(33))).toBe(false);
    expect(isNavigableSymbol("BTC")).toBe(true);
  });

  it("trims whitespace but preserves symbol case for the route", () => {
    expect(alertCoinNavigation(base({ symbol: "  op  " })).path).toBe("/coin/op");
  });

  it("carries direction, strength and id for the destination banner", () => {
    const nav = alertCoinNavigation(
      base({ symbol: "ETH", direction: "SHORT", type: "SIGNAL_INVALIDATED", currentStrength: 61 }),
    );
    expect(nav.state?.fromAlert).toMatchObject({
      id: "OP|LONG|15m|BOUNCE|1::NEW_SIGNAL",
      type: "SIGNAL_INVALIDATED",
      direction: "SHORT",
      strength: 61,
    });
  });
});
