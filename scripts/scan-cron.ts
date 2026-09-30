/**
 * Headless paper-signal scan for GitHub Actions schedule (no browser).
 * Reads server-side env only (never VITE_*); exits non-zero on fatal or
 * total failure so the workflow visibly fails. Usage: npm run scan:cron
 */

import { getMarkets } from "../src/market/hyperliquid/index.js";
import { runFullScan, type ScanSummary } from "../src/scanner/engine.js";
import type { Market, Timeframe } from "../src/market/hyperliquid/types.js";
import type { MarketCategory } from "../src/market/classify.js";
import type { SignalEvent } from "../src/alerts/events.js";
import { createSupabaseStateStore } from "../src/cron/state.js";
import { createTelegramSender, deliverEvents } from "../src/cron/notify.js";
import { runOnce, type CronSettings } from "../src/cron/runner.js";

function required(name: string): string {
  const v = (process.env[name] ?? "").trim();
  if (!v) {
    console.error(`Missing required env ${name}.`);
    process.exit(2);
  }
  return v;
}

function parseCategories(raw: string): MarketCategory[] {
  const want = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s === "crypto" || s === "stocks" || s === "commodities") as MarketCategory[];
  return [...new Set(want)];
}

function parseStrength(raw: string): 60 | 70 | 80 | 90 {
  const n = Number(raw);
  return n === 60 || n === 70 || n === 80 || n === 90 ? n : 70;
}

function parseDirections(raw: string): ("LONG" | "SHORT")[] {
  const dirs = raw
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter((s) => s === "LONG" || s === "SHORT") as ("LONG" | "SHORT")[];
  return dirs.length > 0 ? [...new Set(dirs)] : ["LONG", "SHORT"];
}

async function main(): Promise<void> {
  const supabaseUrl = required("SUPABASE_URL");
  const serviceKey = required("SUPABASE_SERVICE_ROLE_KEY");
  const botToken = required("TELEGRAM_BOT_TOKEN");
  const siteUrl = (process.env.SITE_URL ?? "https://sunilkjt.github.io/crypto-paper").trim();
  const categories = parseCategories(process.env.SCAN_CATEGORIES ?? "crypto,stocks,commodities");
  const settings: CronSettings = {
    categories: categories.length > 0 ? categories : ["crypto", "stocks", "commodities"],
    minStrength: parseStrength(process.env.NOTIFY_MIN_STRENGTH ?? "70"),
    directions: parseDirections(process.env.NOTIFY_DIRECTIONS ?? "LONG,SHORT"),
    cooldownMs: Math.max(0, Number(process.env.NOTIFY_COOLDOWN_MINUTES ?? "30") || 0) * 60_000,
    universeCap: Math.max(1, Number(process.env.UNIVERSE_CAP ?? "60") || 60),
    concurrency: 5,
  };
  const log = (msg: string) => console.log(`[scan-cron] ${msg}`);
  log(
    `categories=${settings.categories.join(",")} minStrength=${settings.minStrength} ` +
      `directions=${settings.directions.join(",")} cooldownMin=${settings.cooldownMs / 60_000} ` +
      `service_role=${serviceKey.length > 0 ? "set" : "missing"} bot_token=${botToken.length > 0 ? "set" : "missing"}`,
  );

  const store = createSupabaseStateStore({ url: supabaseUrl, serviceKey });
  const sender = createTelegramSender({ token: botToken });

  const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };
  const report = await runOnce(settings, {
    now: Date.now(),
    markets: (await getMarkets()).markets,
    scanCategory: (universe: Market[], _category: MarketCategory): Promise<ScanSummary> =>
      runFullScan(universe, {
        eligibility: { minVolumeNotional: 250_000, universeSize: settings.universeCap },
        setupTimeframe: "15m" as Timeframe,
        concurrency: settings.concurrency,
        onProgress: (done, total) => log(`scan progress ${done}/${total}`),
      }),
    loadState: () => store.load(),
    saveState: (s) => store.save(s),
    listChats: async (): Promise<string[]> => {
      const res = await fetch(
        `${supabaseUrl.replace(/\/$/, "")}/rest/v1/telegram_connections?enabled=eq.true&select=telegram_chat_id`,
        { headers },
      );
      if (!res.ok) throw new Error(`Chat list failed (HTTP ${res.status}).`);
      const rows = (await res.json()) as Array<{ telegram_chat_id?: unknown }>;
      return rows
        .map((r) => (typeof r.telegram_chat_id === "string" ? r.telegram_chat_id : ""))
        .filter((c) => c.length > 0);
    },
    deliver: (events: SignalEvent[], chats: string[]) => deliverEvents(events, chats, sender, siteUrl, log),
    log,
  });

  console.log(`[scan-cron] report ${JSON.stringify(report)}`);
  const failed = report.categories.filter((c) => c.errors.length > 0);
  if (report.categories.length > 0 && failed.length === report.categories.length) {
    console.error("[scan-cron] all categories failed");
    process.exit(1);
  }
}

main().catch((e: unknown) => {
  console.error(`[scan-cron] fatal: ${e instanceof Error ? e.message : "unknown"}`);
  process.exit(1);
});
