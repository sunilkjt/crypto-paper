// Re-inline supabase/functions/_shared/commands.ts into the deployable
// telegram-webhook/index.ts (dashboard deploys are single-file and cannot
// resolve relative imports). Idempotent: replaces the marked section.
// Usage: npm run bundle:webhook
import { readFileSync, writeFileSync } from "node:fs";

const SHARED = new URL("../supabase/functions/_shared/commands.ts", import.meta.url);
const TARGET = new URL("../supabase/functions/telegram-webhook/index.ts", import.meta.url);

const shared = readFileSync(SHARED, "utf8").replace(/\r\n/g, "\n");
let web = readFileSync(TARGET, "utf8").replace(/\r\n/g, "\n");

const markerRe = /\/\/ ---- Inlined from \.\.\/_shared\/commands\.ts[\s\S]*?(?=^interface TelegramUpdate)/m;
if (!markerRe.test(web)) {
  console.error("bundle-webhook: inlined section markers not found; refusing to rewrite.");
  process.exit(2);
}
const section =
  "// ---- Inlined from ../_shared/commands.ts (dashboard deploys are single-file;\n" +
  "// ---- source of truth, unit-tested via vitest) ----\n" +
  shared.trimEnd() +
  "\n\n";
web = web.replace(markerRe, section);
writeFileSync(TARGET, web);
console.log("bundle-webhook: inlined shared module OK");
