import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Reusable Supabase client (frontend only).
 * Reads ONLY VITE_SUPABASE_URL + VITE_SUPABASE_PUBLISHABLE_KEY (anon/publishable).
 * Never hard-codes keys; never use sb_secret_* / service_role here.
 */

/**
 * Env read that is safe in every runtime. Vite replaces import.meta.env at
 * build time; under plain Node/tsx (headless cron, tests) it is undefined
 * and a top-level read would crash the whole import graph. Never read env
 * at module scope — always go through here, lazily.
 */
function readEnv(name: string): string {
  try {
    const env = (import.meta as unknown as { env?: Record<string, unknown> } | undefined)?.env;
    const v = env?.[name];
    return typeof v === "string" ? v.trim() : "";
  } catch {
    return "";
  }
}

function supabaseUrl(): string {
  return readEnv("VITE_SUPABASE_URL");
}

// Canonical name per spec; accept legacy ANON key as fallback for existing setups.
function supabaseKey(): string {
  return readEnv("VITE_SUPABASE_PUBLISHABLE_KEY") || readEnv("VITE_SUPABASE_ANON_KEY");
}

export function isSupabaseConfigured(): boolean {
  return supabaseUrl().length > 0 && supabaseKey().length > 0;
}

export function supabaseEnvStatus(): { url: boolean; key: boolean } {
  return { url: supabaseUrl().length > 0, key: supabaseKey().length > 0 };
}

let cached: SupabaseClient | null = null;
let cachedFor = "";

export function getSupabase(): SupabaseClient | null {
  const url = supabaseUrl();
  const key = supabaseKey();
  if (url.length === 0 || key.length === 0) return null;
  if (!cached || cachedFor !== `${url}|${key}`) {
    cachedFor = `${url}|${key}`;
    cached = createClient(url, key, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        storageKey: "cryptoin:supabase-auth:v1",
      },
    });
  }
  return cached;
}

/** Test seam. */
export function resetSupabaseClient(): void {
  cached = null;
  cachedFor = "";
}
