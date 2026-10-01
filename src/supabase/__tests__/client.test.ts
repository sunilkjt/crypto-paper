import { describe, expect, it } from "vitest";
import {
  getSupabase,
  isSupabaseConfigured,
  resetSupabaseClient,
  supabaseEnvStatus,
} from "../client";

/**
 * Regression: src/supabase/client.ts is imported by the headless cron and
 * watchdog graphs, which run under plain Node/tsx where import.meta.env
 * does not exist. Env reads must therefore be lazy and guarded — importing
 * this module must never throw, and an unconfigured client must report
 * itself as such instead of crashing the whole job at import time.
 */
describe("supabase client env handling", () => {
  it("imports safely and reports unconfigured without VITE_* env", () => {
    expect(() => resetSupabaseClient()).not.toThrow();
    expect(isSupabaseConfigured()).toBe(false);
    expect(supabaseEnvStatus()).toEqual({ url: false, key: false });
    expect(getSupabase()).toBeNull();
  });
});
