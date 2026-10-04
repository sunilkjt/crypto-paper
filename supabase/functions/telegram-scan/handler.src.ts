// Supabase Edge Function SOURCE: telegram-scan (Deno).
//
// Manual on-demand market scan for Telegram `/scan`. Same deterministic
// engine as the 24/7 cron (market discovery → candles → signal engine →
// scoring), but strictly READ-ONLY:
//
// - NO cron state reads/writes (scheduled scanner untouched)
// - NO signal_history writes (never fabricates scheduled-signal rows)
// - NO notification cooldown/fingerprint gate (user explicitly asked)
// - NO AI (engine decides everything, as always)
//
// Invoked server-to-server by telegram-webhook with the service-role key.
// NEVER callable from the browser (no CORS, service-role auth required).
// The chat_id in the payload is re-validated against telegram_connections.
//
// DO NOT EDIT the generated sibling index.ts — edit this file, then run:
//   npm run bundle:scan
// Deploy: supabase functions deploy telegram-scan
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TELEGRAM_BOT_TOKEN (all server-side only)

import { getMarkets } from "../../../src/market/hyperliquid/index";
import { runFullScan } from "../../../src/scanner/engine";
import type { Market, Timeframe } from "../../../src/market/hyperliquid/types";
import type { MarketCategory } from "../../../src/market/classify";
import {
  SCAN_BUSY_MESSAGE,
  SCAN_FAILED_MESSAGE,
  SCAN_UNAUTHORIZED_MESSAGE,
  formatManualScanResult,
  parseScanArgs,
  runManualMarketScan,
  verifyScanAccess,
} from "../../../src/cron/manualScan";
import { splitMessage } from "../_shared/commands";

const SCAN_DEADLINE_MS = 140_000;
const MAX_CHUNKS = 6;

type DenoGlobals = {
  Deno?: {
    env: { get: (key: string) => string | undefined };
    serve: (handler: (req: Request) => Promise<Response>) => void;
  };
  EdgeRuntime?: { waitUntil: (p: Promise<unknown>) => void };
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

async function botCall(botToken: string, method: string, payload: Record<string, unknown>): Promise<boolean> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function dbGet(
  supabaseUrl: string,
  serviceKey: string,
  path: string,
): Promise<{ status: number; json: unknown }> {
  try {
    const res = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      // ignore body read failures
    }
    return { status: res.status, json: body };
  } catch {
    return { status: 0, json: null };
  }
}

interface ScanInvoke {
  chat_id?: unknown;
  args?: unknown;
  ack_message_id?: unknown;
}

async function handleScan(
  env: { supabaseUrl: string; serviceKey: string; botToken: string },
  invoke: ScanInvoke,
): Promise<void> {
  const chat = typeof invoke.chat_id === "string" ? invoke.chat_id : "";
  const args = typeof invoke.args === "string" ? invoke.args : "";
  const ackId = typeof invoke.ack_message_id === "number" ? invoke.ack_message_id : null;
  if (chat === "") return;

  const lookup = async (chatId: string) => {
    const r = await dbGet(
      env.supabaseUrl,
      env.serviceKey,
      `telegram_connections?telegram_chat_id=eq.${encodeURIComponent(chatId)}&select=user_id,enabled`,
    );
    const row =
      r.status === 200 && Array.isArray(r.json) && r.json.length > 0
        ? (r.json[0] as { user_id?: unknown; enabled?: unknown })
        : null;
    return { paired: row !== null, enabled: row?.enabled === true };
  };
  const access = await verifyScanAccess(lookup, chat).catch(() => ({ ok: false as const, reason: "unpaired" as const }));
  if (!access.ok) {
    const text =
      access.reason === "paused"
        ? "⏸️ Notifications are paused for this chat. Reconnect from the website (Settings → Telegram) to resume."
        : SCAN_UNAUTHORIZED_MESSAGE;
    if (ackId !== null) {
      await botCall(env.botToken, "editMessageText", { chat_id: chat, message_id: ackId, text: text.slice(0, 3500) });
    } else {
      await botCall(env.botToken, "sendMessage", { chat_id: chat, text: text.slice(0, 3500) });
    }
    return;
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SCAN_DEADLINE_MS);
  try {
    const request = parseScanArgs(args);
    const result = await runManualMarketScan(
      {
        now: Date.now(),
        listMarkets: () => getMarkets({ bypassCache: true, signal: ctrl.signal }),
        scanCategory: (universe: Market[], _category: MarketCategory) =>
          runFullScan(universe, {
            eligibility: { minVolumeNotional: 250_000, universeSize: 60 },
            setupTimeframe: "15m" as Timeframe,
            concurrency: 5,
            signal: ctrl.signal,
          }),
        signal: ctrl.signal,
      },
      request,
    );
    const chunks = splitMessage(formatManualScanResult(result)).slice(0, MAX_CHUNKS);
    if (chunks.length === 0) return;
    if (ackId !== null) {
      await botCall(env.botToken, "editMessageText", {
        chat_id: chat,
        message_id: ackId,
        text: chunks[0].slice(0, 3500),
      });
      for (const rest of chunks.slice(1)) {
        await botCall(env.botToken, "sendMessage", { chat_id: chat, text: rest.slice(0, 3500) });
      }
    } else {
      for (const chunk of chunks) {
        await botCall(env.botToken, "sendMessage", { chat_id: chat, text: chunk.slice(0, 3500) });
      }
    }
  } catch {
    // ManualScanError (no fresh data) and unexpected errors both map to
    // the same honest failure text — never stale data presented as fresh,
    // never internals leaked to the chat.
    const text = SCAN_FAILED_MESSAGE;
    if (ackId !== null) {
      await botCall(env.botToken, "editMessageText", { chat_id: chat, message_id: ackId, text });
    } else {
      await botCall(env.botToken, "sendMessage", { chat_id: chat, text });
    }
  } finally {
    clearTimeout(timer);
  }
}

async function serve(req: Request): Promise<Response> {
  const g = globals();
  const supabaseUrl = g.Deno?.env.get("SUPABASE_URL") ?? "";
  const serviceKey = g.Deno?.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const botToken = g.Deno?.env.get("TELEGRAM_BOT_TOKEN") ?? "";
  if (supabaseUrl === "" || serviceKey === "" || botToken === "") {
    return json(500, { ok: false, error: "scan service not configured" });
  }
  if (req.method !== "POST") return json(405, { ok: false });
  const auth = req.headers.get("authorization") ?? "";
  if (auth !== `Bearer ${serviceKey}`) {
    return json(401, { ok: false });
  }
  let invoke: ScanInvoke;
  try {
    invoke = (await req.json()) as ScanInvoke;
  } catch {
    return json(400, { ok: false });
  }
  const chat = typeof invoke.chat_id === "string" ? invoke.chat_id : "";
  if (chat === "") return json(400, { ok: false });

  if (running.has(chat)) {
    await botCall(botToken, "sendMessage", { chat_id: chat, text: SCAN_BUSY_MESSAGE });
    return json(202, { ok: true, accepted: false, reason: "busy" });
  }
  running.add(chat);
  const env = { supabaseUrl, serviceKey, botToken };
  const done = handleScan(env, invoke).finally(() => running.delete(chat));
  const runtime = g.EdgeRuntime;
  if (runtime && typeof runtime.waitUntil === "function") {
    runtime.waitUntil(done);
  } else {
    await done;
  }
  return json(202, { ok: true, accepted: true });
}

/** Per-chat concurrency guard (per isolate, best effort). */
const running = new Set<string>();

const deno = globals().Deno;
if (deno && typeof deno.serve === "function") {
  deno.serve(serve);
}

export { serve, handleScan, running };
// Re-exported so the generated bundle carries the (tested) scan service.
export {
  formatManualScanResult,
  parseScanArgs,
  runManualMarketScan,
} from "../../../src/cron/manualScan";
