/**
 * Read-only Supabase setup check (no browser, no writes, no secrets printed).
 * Verifies every table the app/cron/bot needs plus edge-function presence.
 * Usage: SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npm run supabase:doctor
 * Exit 0 = all present; exit 1 = something missing or unreachable.
 */

const TABLES: { table: string; migration: string }[] = [
  { table: "paper_accounts", migration: "0001" },
  { table: "paper_positions", migration: "0001" },
  { table: "paper_trades", migration: "0001" },
  { table: "paper_equity_snapshots", migration: "0001" },
  { table: "telegram_connections", migration: "0002" },
  { table: "telegram_connect_tokens", migration: "0002" },
  { table: "scanner_state", migration: "0003" },
  { table: "signal_history", migration: "0004" },
  { table: "notification_claims", migration: "0005" },
];

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

async function main(): Promise<void> {
  const url = (process.env.SUPABASE_URL ?? "").trim().replace(/\/$/, "");
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim();
  if (!url || !key) {
    console.error("doctor: missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
    process.exit(2);
  }
  const headers = { apikey: key, Authorization: `Bearer ${key}` };
  const get = async (path: string, init?: RequestInit) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15_000);
    try {
      return await fetch(`${url}${path}`, { ...init, headers: { ...headers, ...(init?.headers ?? {}) }, signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
  };

  const checks: Check[] = [];
  for (const t of TABLES) {
    try {
      const res = await get(`/rest/v1/${t.table}?select=*&limit=1`);
      if (res.status === 404) {
        checks.push({ name: `table ${t.table}`, ok: false, detail: `missing — run migration ${t.migration}` });
      } else if (!res.ok) {
        checks.push({ name: `table ${t.table}`, ok: false, detail: `HTTP ${res.status}` });
      } else {
        checks.push({ name: `table ${t.table}`, ok: true, detail: "present" });
      }
    } catch {
      checks.push({ name: `table ${t.table}`, ok: false, detail: "unreachable" });
    }
  }

  // Edge functions: unauthenticated probes distinguish deployed (401/405/400)
  // from missing (404). No credentials sent, nothing executed.
  const fns: { name: string; method: string; body?: string; deployed: number[] }[] = [
    { name: "telegram-link", method: "POST", body: JSON.stringify({ action: "status" }), deployed: [401] },
    { name: "telegram-notify", method: "POST", body: JSON.stringify({}), deployed: [401] },
    { name: "telegram-webhook", method: "GET", deployed: [405] },
    { name: "explain-signal", method: "POST", body: JSON.stringify({}), deployed: [400, 503] },
  ];
  for (const fn of fns) {
    try {
      const res = await get(`/functions/v1/${fn.name}`, {
        method: fn.method,
        headers: { "Content-Type": "application/json" },
        body: fn.body,
      });
      if (res.status === 404) {
        checks.push({ name: `function ${fn.name}`, ok: false, detail: "not deployed" });
      } else if (fn.deployed.includes(res.status)) {
        checks.push({ name: `function ${fn.name}`, ok: true, detail: `reachable (HTTP ${res.status})` });
      } else {
        checks.push({ name: `function ${fn.name}`, ok: false, detail: `unexpected HTTP ${res.status}` });
      }
    } catch {
      checks.push({ name: `function ${fn.name}`, ok: false, detail: "unreachable" });
    }
  }

  let failed = 0;
  for (const c of checks) {
    console.log(`[doctor] ${c.ok ? "PASS" : "FAIL"} ${c.name} — ${c.detail}`);
    if (!c.ok) failed += 1;
  }
  console.log(`[doctor] ${checks.length - failed}/${checks.length} checks passed`);
  if (failed > 0) process.exit(1);
}

main().catch((e: unknown) => {
  console.error(`[doctor] fatal: ${e instanceof Error ? e.message : "unknown"}`);
  process.exit(1);
});
