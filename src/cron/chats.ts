/**
 * Linked-chat listing shared by the scan cron and the watchdog (service
 * role REST; enabled connections only). Single implementation so both
 * surfaces enumerate recipients identically.
 */

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export async function listEnabledChats(opts: {
  url: string;
  serviceKey: string;
  fetchFn?: FetchFn;
}): Promise<string[]> {
  const run = opts.fetchFn ?? fetch;
  const headers = {
    apikey: opts.serviceKey,
    Authorization: `Bearer ${opts.serviceKey}`,
  };
  const res = await run(
    `${opts.url.replace(/\/$/, "")}/rest/v1/telegram_connections?enabled=eq.true&select=telegram_chat_id`,
    { headers },
  );
  if (!res.ok) throw new Error(`Chat list failed (HTTP ${res.status}).`);
  const rows = (await res.json()) as Array<{ telegram_chat_id?: unknown }>;
  return rows
    .map((r) => (typeof r.telegram_chat_id === "string" ? r.telegram_chat_id : ""))
    .filter((c) => c.length > 0);
}
