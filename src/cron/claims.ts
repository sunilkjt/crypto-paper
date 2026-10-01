/**
 * Cron side of the atomic notification gate (migration 0005). Same RPC
 * contract as the browser path (src/supabase/claims.ts) over plain REST
 * with the service-role key — shared semantics, shared fingerprint shape.
 *
 * ClaimFn returns:
 * - true  — this worker won the delivery right.
 * - false — another worker holds an unexpired claim: suppress delivery.
 * - null  — transport failure: caller falls back to its local cooldown map
 *           (legacy behavior preserved exactly when Supabase is down).
 */

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export type ClaimFn = (fingerprint: string, cooldownMs: number) => Promise<boolean | null>;
export type ReleaseFn = (fingerprint: string) => Promise<void>;

export function createClaimTransport(opts: {
  url: string;
  serviceKey: string;
  fetchFn?: FetchFn;
}): { claim: ClaimFn; release: ReleaseFn } {
  const base = opts.url.replace(/\/$/, "");
  const run = opts.fetchFn ?? fetch;
  const headers = {
    apikey: opts.serviceKey,
    Authorization: `Bearer ${opts.serviceKey}`,
    "Content-Type": "application/json",
  };
  return {
    async claim(fingerprint: string, cooldownMs: number): Promise<boolean | null> {
      try {
        const res = await run(`${base}/rest/v1/rpc/claim_notification`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            p_fingerprint: fingerprint,
            p_cooldown_ms: cooldownMs,
            p_now: new Date().toISOString(),
          }),
        });
        if (!res.ok) return null;
        const data: unknown = await res.json().catch(() => null);
        return data === true;
      } catch {
        return null;
      }
    },
    async release(fingerprint: string): Promise<void> {
      try {
        await run(`${base}/rest/v1/rpc/release_notification_claim`, {
          method: "POST",
          headers,
          body: JSON.stringify({ p_fingerprint: fingerprint }),
        });
      } catch {
        // best effort
      }
    },
  };
}
