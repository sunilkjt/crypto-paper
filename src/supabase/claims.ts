import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabase } from "./client";

/**
 * Browser side of the atomic notification gate (migration 0005).
 *
 * claimDelivery() returns:
 * - true  — this worker won the delivery right (or cooldown is off/empty).
 * - false — another worker holds an unexpired claim: suppress delivery.
 * - null  — transport failure / unconfigured: caller falls back to its
 *           local gate, preserving exact pre-atomic offline behavior.
 *
 * releaseDeliveryClaim() burns a won claim after a FAILED send so a later
 * attempt may proceed instead of being suppressed as delivered. Best
 * effort, never throws.
 */

export async function claimDeliveryRemote(
  client: SupabaseClient,
  fingerprint: string,
  cooldownMs: number,
): Promise<boolean | null> {
  try {
    const { data, error } = await client.rpc("claim_notification", {
      p_fingerprint: fingerprint,
      p_cooldown_ms: cooldownMs,
      p_now: new Date().toISOString(),
    });
    if (error) return null;
    return data === true;
  } catch {
    return null;
  }
}

export async function releaseDeliveryRemote(
  client: SupabaseClient,
  fingerprint: string,
): Promise<void> {
  try {
    await client.rpc("release_notification_claim", { p_fingerprint: fingerprint });
  } catch {
    // best effort
  }
}

export async function claimDelivery(fingerprint: string, cooldownMs: number): Promise<boolean | null> {
  const sb = getSupabase();
  if (!sb) return null;
  return claimDeliveryRemote(sb, fingerprint, cooldownMs);
}

export async function releaseDeliveryClaim(fingerprint: string): Promise<void> {
  const sb = getSupabase();
  if (!sb) return;
  await releaseDeliveryRemote(sb, fingerprint);
}
