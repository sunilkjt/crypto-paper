import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Reusable Supabase client (frontend only).
 * Reads ONLY VITE_SUPABASE_URL + VITE_SUPABASE_PUBLISHABLE_KEY (anon/publishable).
 * Never hard-codes keys; never use sb_secret_* / service_role here.
 */

const URL = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.trim() ?? "";
// Canonical name per spec; accept legacy ANON key as fallback for existing setups.
const KEY =
  ((import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined) ??
    (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined) ??
    "").trim();

export function isSupabaseConfigured(): boolean {
  return URL.length > 0 && KEY.length > 0;
}

export function supabaseEnvStatus(): { url: boolean; key: boolean } {
  return { url: URL.length > 0, key: KEY.length > 0 };
}

let cached: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient | null {
  if (!isSupabaseConfigured()) return null;
  if (!cached) {
    cached = createClient(URL, KEY, {
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
}
