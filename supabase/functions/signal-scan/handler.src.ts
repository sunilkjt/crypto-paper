// Supabase Edge Function SOURCE: signal-scan (Deno).
//
// Scheduled 5-minute signal scanner (Supabase-native 24/7 trigger).
// Runs the FULL headless cron pipeline — the same deterministic engine as
// scripts/scan-cron.ts (market discovery → per-category runFullScan →
// lifecycle transitions vs persisted state → cooldown-gated Telegram
// delivery → state save + signal_history upsert + heartbeat):
//
// - READS/WRITES cron state (scanner_state key `cron-monitor`)
// - WRITES signal_history (every qualifying signal, delivery-independent)
// - CLAIMS notification fingerprints (atomic cross-worker gate)
// - DELIVERS to all enabled telegram_connections chats
// - NEVER calls AI, never trades, never writes journals
//
// This is NOT telegram-scan (that function is a read-only manual `/scan`
// endpoint: no state, no history, no broadcast — scheduling it on a timer
// would deliver nothing). This function IS the scheduled scanner.
//
// Trigger: Supabase pg_cron + pg_net every 5 minutes (migration 0010),
// server-to-server with the service-role key. NEVER callable from the
// browser (no CORS, service-role auth required).
//
// DO NOT EDIT the generated sibling index.ts — edit this file, then run:
//   npm run bundle:signal-scan
// Deploy: supabase functions deploy signal-scan
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TELEGRAM_BOT_TOKEN (all server-side only)

import { getMarkets } from "../../../src/market/hyperliquid/index";
import { runFullScan, type ScanSummary } from "../../../src/scanner/engine";
import type { Market, Timeframe } from "../../../src/market/hyperliquid/types";
import type { MarketCategory } from "../../../src/market/classify";
import { eventCategoryLabel, eventMessage, type SignalEvent } from "../../../src/alerts/events";
import { createSupabaseStateStore } from "../../../src/cron/state";
import { createHistoryStore, type HistoryRow } from "../../../src/cron/history";
import { createClaimTransport } from "../../../src/cron/claims";
import { listEnabledChats } from "../../../src/cron/chats";
import { runOnce, type CronSettings } from "../../../src/cron/runner";

type DenoGlobals = {
  Deno?: {
    env: { get: (key: string) => string | undefined };
    serve: (handler: (req: Request) => Promise<Response>) => void;
  };
};

function globals(): DenoGlobals {
  return globalThis as unknown as DenoGlobals;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// --- Telegram delivery (inlined so this bundle never pulls the browser
// --- provider chain: src/cron/notify.ts → alerts/providers.ts → supabase-js.
// --- Message text matches formatTelegramMessage exactly; Bot API direct. ---

function formatScanMessage(event: SignalEvent): string {
  const s = event.signal;
  const arrow = event.direction === "LONG" ? "📈" : "📉";
  const lines = [
    `${arrow} ${eventCategoryLabel(event)} ${event.direction}`,
    "",
    event.symbol,
    "",
    `Score: ${event.currentStrength}/100`,
    `Entry: ${s.entryLow ?? "—"} – ${s.entryHigh ?? "—"}`,
    `Stop Loss: ${s.invalidation ?? "—"}`,
    `TP1: ${s.tp1 ?? "—"}`,
    `TP2: ${s.tp2 ?? "—"}`,
    `TP3: ${s.tp3 ?? "—"}`,
    `R:R: ${s.riskReward !== null && s.riskReward !== undefined ? `1 : ${s.riskReward}` : "—"}`,
    "",
    `Timeframe: ${event.timeframe}`,
    "",
    "Setup:",
    eventMessage(event),
    "",
    "Reasons:",
    ...s.reasons.slice(0, 5).map((r) => `• ${r}`),
    "",
    "Risk:",
    ...(s.warnings.length > 0 ? s.warnings.slice(0, 4).map((w) => `• ${w}`) : ["• No specific warnings recorded."]),
    "",
    "Strength is confluence, not a probability of success.",
  ];
  return lines.join("\n");
}

function analysisUrl(siteUrl: string, symbol: string): string {
  return `${siteUrl.replace(/\/$/, "")}/#/coin/${symbol.trim()}`;
}

async function sendToChat(
  botToken: string,
  chatId: string,
  text: string,
  url: string | null,
  log: (msg: string) => void,
): Promise<boolean> {
  const payload: Record<string, unknown> = { chat_id: chatId, text: text.slice(0, 3500) };
  if (url) {
    payload.reply_markup = { inline_keyboard: [[{ text: "View Analysis", url }]] };
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) return true;
    log(`delivery to ****${chatId.slice(-4)} failed (http-${res.status})`);
    return false;
  } catch {
    log(`delivery to ****${chatId.slice(-4)} failed (network)`);
    return false;
  }
}

// --- Settings (same defaults as the GitHub cron workflow) ---

function parseCategories(raw: string): MarketCategory[] {
  const want = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s === "crypto" || s === "stocks" || s === "commodities") as MarketCategory[];
  const uniq = [...new Set(want)];
  return uniq.length > 0 ? uniq : ["crypto", "stocks", "commodities"];
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

function readSettings(env: {
  SCAN_CATEGORIES?: string;
  NOTIFY_MIN_STRENGTH?: string;
  NOTIFY_DIRECTIONS?: string;
  NOTIFY_COOLDOWN_MINUTES?: string;
  UNIVERSE_CAP?: string;
  SCAN_CONCURRENCY?: string;
}): CronSettings {
  const cooldownMin = Math.max(0, Number(env.NOTIFY_COOLDOWN_MINUTES ?? "30") || 0);
  return {
    categories: parseCategories(env.SCAN_CATEGORIES ?? "crypto,stocks,commodities"),
    minStrength: parseStrength(env.NOTIFY_MIN_STRENGTH ?? "70"),
    directions: parseDirections(env.NOTIFY_DIRECTIONS ?? "LONG,SHORT"),
    cooldownMs: cooldownMin * 60_000,
    universeCap: Math.max(1, Number(env.UNIVERSE_CAP ?? "60") || 60),
    concurrency: Math.max(1, Math.min(8, Number(env.SCAN_CONCURRENCY ?? "5") || 5)),
  };
}

interface ScanRequestBody {
  categories?: unknown;
  min_strength?: unknown;
  cooldown_minutes?: unknown;
  dry_run?: unknown;
}

/** Per-isolate overlap guard: a 5-min tick arriving while a scan runs waits for the next tick. */
let running = false;

async function serve(req: Request): Promise<Response> {
  const g = globals();
  const supabaseUrl = g.Deno?.env.get("SUPABASE_URL") ?? "";
  const serviceKey = g.Deno?.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const botToken = g.Deno?.env.get("TELEGRAM_BOT_TOKEN") ?? "";
  const siteUrl =
    (g.Deno?.env.get("SITE_URL") ?? "").trim() || "https://sunilkjt.github.io/crypto-paper";
  if (supabaseUrl === "" || serviceKey === "" || botToken === "") {
    return json(500, { ok: false, error: "scan service not configured" });
  }
  if (req.method !== "POST") return json(405, { ok: false });
  const auth = req.headers.get("authorization") ?? "";
  if (auth !== `Bearer ${serviceKey}`) {
    return json(401, { ok: false });
  }
  if (running) {
    return json(202, { ok: true, accepted: false, reason: "busy" });
  }

  let body: ScanRequestBody = {};
  try {
    const text = await req.text();
    body = text.trim() === "" ? {} : (JSON.parse(text) as ScanRequestBody);
  } catch {
    return json(400, { ok: false });
  }

  const settings = readSettings({
    SCAN_CATEGORIES:
      typeof body.categories === "string" ? body.categories : (g.Deno?.env.get("SCAN_CATEGORIES") ?? undefined),
    NOTIFY_MIN_STRENGTH:
      body.min_strength !== undefined ? String(body.min_strength) : (g.Deno?.env.get("NOTIFY_MIN_STRENGTH") ?? undefined),
    NOTIFY_DIRECTIONS: g.Deno?.env.get("NOTIFY_DIRECTIONS") ?? undefined,
    NOTIFY_COOLDOWN_MINUTES:
      body.cooldown_minutes !== undefined
        ? String(body.cooldown_minutes)
        : (g.Deno?.env.get("NOTIFY_COOLDOWN_MINUTES") ?? undefined),
    UNIVERSE_CAP: g.Deno?.env.get("UNIVERSE_CAP") ?? undefined,
    SCAN_CONCURRENCY: g.Deno?.env.get("SCAN_CONCURRENCY") ?? undefined,
  });
  const dryRun = body.dry_run === true;

  const log = (msg: string) => console.log(`[signal-scan] ${msg}`);
  log(
    `categories=${settings.categories.join(",")} minStrength=${settings.minStrength} ` +
      `directions=${settings.directions.join(",")} cooldownMin=${settings.cooldownMs / 60_000} ` +
      `universeCap=${settings.universeCap} concurrency=${settings.concurrency} dryRun=${dryRun}`,
  );

  running = true;
  try {
    const store = createSupabaseStateStore({ url: supabaseUrl, serviceKey });
    const history = createHistoryStore({ url: supabaseUrl, serviceKey });
    const gate = createClaimTransport({ url: supabaseUrl, serviceKey });

    let markets: Market[];
    try {
      markets = (await getMarkets()).markets;
    } catch (e) {
      const msg = e instanceof Error ? e.message : "market discovery failed";
      log(`market discovery FAILED: ${msg}`);
      return json(502, { ok: false, error: msg });
    }

    const report = await runOnce(settings, {
      now: Date.now(),
      markets,
      scanCategory: (universe: Market[], _category: MarketCategory): Promise<ScanSummary> =>
        runFullScan(universe, {
          eligibility: { minVolumeNotional: 250_000, universeSize: settings.universeCap },
          setupTimeframe: "15m" as Timeframe,
          concurrency: settings.concurrency,
          onProgress: (done, total) => log(`scan progress ${done}/${total}`),
        }),
      loadState: () => store.load(),
      saveState: (s) => store.save(s),
      claim: (fp, ms) => gate.claim(fp, ms),
      release: (fp) => gate.release(fp),
      saveHistory: async (rows: HistoryRow[]) => {
        if (dryRun) {
          log(`dry_run: skipping history upsert of ${rows.length} rows`);
          return;
        }
        await history.upsert(rows);
        await history.pruneOlderThanDays(30);
      },
      listChats: () => listEnabledChats({ url: supabaseUrl, serviceKey }),
      deliver: async (events: SignalEvent[], chats: string[]) => {
        if (dryRun) {
          log(`dry_run: would deliver ${events.length} events to ${chats.length} chats`);
          return { delivered: 0 };
        }
        let delivered = 0;
        for (const e of events) {
          const message = formatScanMessage(e);
          const url = analysisUrl(siteUrl, e.symbol);
          for (const chat of chats) {
            if (await sendToChat(botToken, chat, message, url, log)) delivered += 1;
          }
        }
        return { delivered };
      },
      log,
    });

    log(`report ${JSON.stringify(report)}`);
    return json(200, { ok: true, delivered: report.totalDelivered, report });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown scan error";
    log(`fatal: ${msg}`);
    return json(500, { ok: false, error: msg });
  } finally {
    running = false;
  }
}

const deno = globals().Deno;
if (deno && typeof deno.serve === "function") {
  deno.serve(serve);
}

export { serve, running, readSettings };
