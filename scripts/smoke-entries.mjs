// CI smoke guard: both headless entries must load under plain Node/tsx.
// Runs them with EMPTY credentials: each must fail fast with exit 2
// ("Missing required env"), proving no module-scope crash (e.g. a bare
// import.meta.env read) can take down a scheduled job at import time.
import { spawnSync } from "node:child_process";

const entries = ["scripts/scan-cron.ts", "scripts/cron-watchdog.ts"];
const scrubbed = { ...process.env };
for (const k of ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "TELEGRAM_BOT_TOKEN"]) {
  delete scrubbed[k];
}

let failed = false;
for (const entry of entries) {
  // Local tsx binary directly (no npx download, no shell needed on Windows).
  const res = spawnSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", entry], {
    env: scrubbed,
    encoding: "utf8",
    timeout: 120_000,
  });
  const output = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  const ok = res.status === 2 && output.includes("Missing required env");
  console.log(`[smoke] ${entry}: exit=${res.status} ${ok ? "OK" : "FAIL"}`);
  if (!ok) {
    console.log(output.slice(0, 2000));
    failed = true;
  }
}
process.exit(failed ? 1 : 0);
