import { describe, expect, it } from "vitest";
import {
  readDiagnostics,
  recordCacheHit,
  recordCacheMiss,
  recordRateLimit,
  recordRestRequest,
  resetDiagnosticsForTests,
  setActiveSubscriptions,
  setWsConnections,
} from "../diagnostics";

describe("diagnostics", () => {
  it("tracks requests, cache, rate limits and sockets", () => {
    resetDiagnosticsForTests();
    recordRestRequest(1000);
    recordRestRequest(2000);
    recordRestRequest(120_000);
    recordCacheHit();
    recordCacheHit();
    recordCacheMiss();
    recordRateLimit();
    setWsConnections(1);
    setActiveSubscriptions(7);
    const snap = readDiagnostics(61_000);
    expect(snap.restRequests).toBe(3);
    expect(snap.restPerMinute).toBe(2); // only the last 60s window
    expect(snap.cacheHits).toBe(2);
    expect(snap.cacheMisses).toBe(1);
    expect(snap.cacheHitRate).toBe(67);
    expect(snap.rateLimits).toBe(1);
    expect(snap.wsConnections).toBe(1);
    expect(snap.wsPeakConnections).toBe(1);
    expect(snap.activeSubscriptions).toBe(7);
    setWsConnections(0);
    expect(readDiagnostics().wsPeakConnections).toBe(1); // peak sticks
  });

  it("handles the empty state without NaN", () => {
    resetDiagnosticsForTests();
    const snap = readDiagnostics();
    expect(snap.cacheHitRate).toBe(0);
    expect(snap.restPerMinute).toBe(0);
  });
});
