// Supabase Edge Function: telegram-webhook (Deno).
//
// Receives Telegram Bot API updates (no user JWT — Telegram servers call
// this). Gateway JWT verification MUST be OFF. Two roles:
//
// PUSH (existing): /start <one-time-token> links the chat; /stop pauses.
// PULL (this feature): paired chats may query /help /status /signals
// /today /last /history — pure Supabase reads + formatting. NEVER scans,
// NEVER calls Hyperliquid, NEVER calls Groq/AI, NEVER trades.
//
// Security: unknown/expired tokens are ignored with HTTP 200 (no oracle);
// unpaired chats get the access message; DB errors map to a generic
// message; the bot token never leaves the server.
//
// Deploy: supabase functions deploy telegram-webhook
// Secrets: TELEGRAM_BOT_TOKEN (server-side only)

import {
  DB_ERROR_MESSAGE,
  EMPTY_MESSAGE,
  formatHelp,
  formatSignalDetail,
  formatSignalLine,
  formatSignalsList,
  formatStatus,
  formatToday,
  parseCommand,
  routeNatural,
  splitMessage,
  symbolFilter,
  UNPAIRED_MESSAGE,
  type SignalRow,
} from "../_shared/commands.ts";

interface TelegramUpdate {
  message?: {
    chat?: { id?: number | string; username?: string };
    from?: { username?: string };
    text?: string;
  };
}

const SITE_URL = Deno.env.get("SITE_URL") ?? "https://sunilkjt.github.io/crypto-paper";

function ok(): Response {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

async function botSend(
  botToken: string,
  chatId: string,
  text: string,
  url: string | null = null,
): Promise<void> {
  try {
    const payload: Record<string, unknown> = { chat_id: chatId, text: text.slice(0, 3500) };
    if (url) {
      payload.reply_markup = { inline_keyboard: [[{ text: "View Analysis", url }]] };
    }
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // best effort
  }
}

function analysisUrl(symbol: string): string {
  return `${SITE_URL.replace(/\/$/, "")}/#/coin/${symbol.trim()}`;
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ ok: true }), {
      status: req.method === "OPTIONS" ? 204 : 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const botToken = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
  if (supabaseUrl === "" || serviceKey === "" || botToken === "") {
    return ok();
  }

  let update: TelegramUpdate;
  try {
    update = (await req.json()) as TelegramUpdate;
  } catch {
    return ok();
  }

  const text = update.message?.text ?? "";
  const chatId = update.message?.chat?.id;
  if (chatId === undefined || chatId === null) return ok();
  const chat = String(chatId);
  const username = update.message?.from?.username ?? update.message?.chat?.username ?? null;

  const dbHeaders = {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
  };
  const db = async (path: string): Promise<{ status: number; json: unknown }> => {
    try {
      const res = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
        headers: dbHeaders,
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
  };
  const admin = {
    async query(path: string): Promise<SignalRow[] | null> {
      const r = await db(path);
      if (r.status !== 200 || !Array.isArray(r.json)) return null;
      return r.json as SignalRow[];
    },
  };

  // /stop from Telegram disables the link (chat-owned action, always safe).
  if (text === "/stop" || text.startsWith("/stop ")) {
    try {
      await fetch(
        `${supabaseUrl}/rest/v1/telegram_connections?telegram_chat_id=eq.${encodeURIComponent(chat)}`,
        {
          method: "PATCH",
          headers: { ...dbHeaders, "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: false }),
          signal: AbortSignal.timeout(10_000),
        },
      );
    } catch {
      // best effort
    }
    await botSend(botToken, chat, "CryptoIn notifications paused for this chat. Reconnect anytime from the website.");
    return ok();
  }

  // /start <token> links the chat (existing pairing flow, unchanged).
  const startMatch = /^\/start\s+([0-9a-fA-F]{16,128})\s*$/.exec(text.trim());
  if (startMatch) {
    const token = startMatch[1].toLowerCase();
    const r = await db(
      `telegram_connect_tokens?token=eq.${encodeURIComponent(token)}&select=user_id,expires_at,used_at`,
    );
    const row =
      r.status === 200 && Array.isArray(r.json) && r.json.length > 0
        ? (r.json[0] as { user_id: string; expires_at: string; used_at: string | null })
        : null;
    const valid = row !== null && row.used_at === null && Date.parse(row.expires_at) > Date.now();
    if (!valid) {
      await botSend(
        botToken,
        chat,
        "That connection link expired or was already used. Please generate a fresh one on the website (Settings → Telegram → Connect).",
      );
      return ok();
    }
    try {
      await fetch(`${supabaseUrl}/rest/v1/telegram_connections`, {
        method: "POST",
        headers: { ...dbHeaders, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" },
        body: JSON.stringify({
          user_id: row.user_id,
          telegram_chat_id: chat,
          telegram_username: username,
          enabled: true,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      await fetch(
        `${supabaseUrl}/rest/v1/telegram_connect_tokens?token=eq.${encodeURIComponent(token)}`,
        {
          method: "PATCH",
          headers: { ...dbHeaders, "Content-Type": "application/json" },
          body: JSON.stringify({ used_at: new Date().toISOString() }),
          signal: AbortSignal.timeout(10_000),
        },
      );
      await fetch(
        `${supabaseUrl}/rest/v1/telegram_connect_tokens?user_id=eq.${encodeURIComponent(row.user_id)}&token=neq.${encodeURIComponent(token)}`,
        { method: "DELETE", headers: dbHeaders, signal: AbortSignal.timeout(10_000) },
      );
    } catch {
      // best effort — the link reply below still fires only on success path
    }
    await botSend(
      botToken,
      chat,
      "✅ CryptoIn connected! Paper-signal notifications for your enabled categories will arrive here. Send /stop anytime to pause.",
    );
    return ok();
  }

  // ---- Read-only commands: pairing gate first ---------------------------
  const connRes = await db(
    `telegram_connections?telegram_chat_id=eq.${encodeURIComponent(chat)}&select=user_id,enabled`,
  );
  const conn =
    connRes.status === 200 && Array.isArray(connRes.json) && connRes.json.length > 0
      ? (connRes.json[0] as { user_id: string; enabled: boolean })
      : null;
  if (!conn) {
    await botSend(botToken, chat, UNPAIRED_MESSAGE);
    return ok();
  }
  if (!conn.enabled) {
    await botSend(
      botToken,
      chat,
      "⏸️ Notifications are paused for this chat. Reconnect from the website (Settings → Telegram) to resume.",
    );
    return ok();
  }

  // Route: explicit command, else deterministic natural-language intent.
  const trimmed = text.trim();
  let parsed = parseCommand(trimmed);
  if (parsed.cmd === "unknown" && !trimmed.startsWith("/")) {
    const routed = routeNatural(trimmed);
    if (routed) parsed = parseCommand(routed);
  }

  const reply = async (body: string, url: string | null = null): Promise<void> => {
    for (const chunk of splitMessage(body)) {
      await botSend(botToken, chat, chunk, url);
    }
  };

  try {
    switch (parsed.cmd) {
      case "help": {
        await reply(formatHelp());
        return ok();
      }
      case "status": {
        const st = await db(
          `scanner_state?key=eq.cron-monitor&select=value`,
        );
        let lastRunAt: number | null = null;
        let perCategory: Record<string, { universe: number; scanned: number; signals: number }> = {};
        let lastDeliveryAt: number | null = null;
        if (st.status === 200 && Array.isArray(st.json) && st.json.length > 0) {
          const v = (st.json[0] as { value?: unknown }).value as {
            lastRun?: {
              at?: unknown;
              perCategory?: unknown;
              delivered?: unknown;
              lastDeliveryAt?: unknown;
            };
          } | undefined;
          if (v && typeof v.lastRun === "object" && v.lastRun !== null) {
            const lr = v.lastRun as {
              at?: unknown;
              perCategory?: Record<string, { universe?: unknown; scanned?: unknown; signals?: unknown }>;
              lastDeliveryAt?: unknown;
            };
            lastRunAt = typeof lr.at === "number" ? lr.at : null;
            lastDeliveryAt = typeof lr.lastDeliveryAt === "number" ? lr.lastDeliveryAt : null;
            for (const [k, c] of Object.entries(lr.perCategory ?? {})) {
              perCategory[k] = {
                universe: typeof c.universe === "number" ? c.universe : 0,
                scanned: typeof c.scanned === "number" ? c.scanned : 0,
                signals: typeof c.signals === "number" ? c.signals : 0,
              };
            }
          }
        }
        await reply(formatStatus({ lastRunAt, perCategory, lastDeliveryAt, now: Date.now() }));
        return ok();
      }
      case "signals": {
        const cat = parsed.category;
        const q = cat
          ? `signal_history?category=eq.${cat}&select=*&order=last_seen.desc&limit=5`
          : `signal_history?select=*&order=last_seen.desc&limit=5`;
        const rows = await admin.query(q);
        if (rows === null) {
          await reply(DB_ERROR_MESSAGE);
          return ok();
        }
        await reply(formatSignalsList(rows));
        return ok();
      }
      case "today": {
        const midnight = new Date();
        midnight.setUTCHours(0, 0, 0, 0);
        const rows = await admin.query(
          `signal_history?last_seen=gte.${encodeURIComponent(midnight.toISOString())}&select=*&order=last_seen.desc&limit=200`,
        );
        if (rows === null) {
          await reply(DB_ERROR_MESSAGE);
          return ok();
        }
        await reply(formatToday(rows));
        return ok();
      }
      case "last": {
        if (!parsed.symbol) {
          const rows = await admin.query(`signal_history?select=*&order=last_seen.desc&limit=1`);
          if (rows === null) {
            await reply(DB_ERROR_MESSAGE);
            return ok();
          }
          if (rows.length === 0) {
            await reply(EMPTY_MESSAGE);
            return ok();
          }
          await reply(formatSignalDetail(rows[0]), analysisUrl(rows[0].symbol));
          return ok();
        }
        const filter = symbolFilter(parsed.symbol);
        if (!filter) {
          await reply(EMPTY_MESSAGE);
          return ok();
        }
        const rows = await admin.query(`signal_history?${filter}&select=*&order=last_seen.desc&limit=1`);
        if (rows === null) {
          await reply(DB_ERROR_MESSAGE);
          return ok();
        }
        if (rows.length === 0) {
          await reply(`No qualifying signals found for ${parsed.symbol}.`);
          return ok();
        }
        await reply(formatSignalDetail(rows[0]), analysisUrl(rows[0].symbol));
        return ok();
      }
      case "history": {
        const rows = await admin.query(
          `signal_history?select=*&order=last_seen.desc&limit=${parsed.limit}`,
        );
        if (rows === null) {
          await reply(DB_ERROR_MESSAGE);
          return ok();
        }
        if (rows.length === 0) {
          await reply(EMPTY_MESSAGE);
          return ok();
        }
        const lines = ["📚 SIGNAL HISTORY", ""];
        rows.forEach((r, i) => lines.push(formatSignalLine(r, i + 1), ""));
        await reply(lines.join("\n").trimEnd());
        return ok();
      }
      default: {
        await reply("I didn't understand that. Send /help for commands I know.");
        return ok();
      }
    }
  } catch {
    await reply(DB_ERROR_MESSAGE);
    return ok();
  }
});
