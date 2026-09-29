// Supabase Edge Function: telegram-notify (Deno).
//
// Authenticated delivery endpoint. Gateway JWT verification stays ON: the
// browser sends its Supabase session JWT and this function reads ONLY the
// caller's own connection row (RLS). The chat_id is NEVER accepted from the
// browser — it always comes from the stored connection.
//
//   POST { message: string, url?: string, symbol?: string, direction?: string }
//     -> { ok: true }  (View Analysis button attached when url is valid)
//   POST { test: true, flags?: { crypto, stocks, commodities } }
//     -> { ok: true }  (connection self-test template, never a real signal)
//
// Plain-text sendMessage (no parse_mode) so signal text can never become
// executable Telegram formatting. The bot token is never returned, logged,
// or echoed. Failures map to sanitized error codes.
//
// Deploy: supabase functions deploy telegram-notify
// Secrets: TELEGRAM_BOT_TOKEN (server-side only)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.2";

const MAX_MESSAGE = 3500;

function corsHeaders(origin: string | null): Record<string, string> {
  const allowed = (Deno.env.get("ALLOWED_ORIGINS") ?? "*")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const allow = allowed.includes("*") || (origin !== null && allowed.includes(origin)) ? "*" : "null";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
    "Content-Type": "application/json",
  };
}

function json(headers: Record<string, string>, status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

function cleanUrl(v: unknown): string | null {
  if (typeof v !== "string" || v.length === 0 || v.length > 500) return null;
  // Production links are https; http is allowed only for local dev origins.
  if (v.startsWith("https://")) return v;
  if (/^http:\/\/localhost(:\d+)?\//.test(v)) return v;
  return null;
}

async function telegramSend(
  botToken: string,
  chatId: string,
  text: string,
  url: string | null,
): Promise<{ ok: boolean; code: string }> {
  const payload: Record<string, unknown> = { chat_id: chatId, text: text.slice(0, MAX_MESSAGE) };
  if (url) {
    payload.reply_markup = { inline_keyboard: [[{ text: "View Analysis", url }]] };
  }
  let res: Response;
  try {
    res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return { ok: false, code: "network" };
  }
  if (res.ok) return { ok: true, code: "sent" };
  let reason = "";
  try {
    const data = (await res.json()) as { description?: unknown };
    reason = typeof data.description === "string" ? data.description : "";
  } catch {
    // ignore body read failures
  }
  const r = reason.toLowerCase();
  if (r.includes("blocked") || r.includes("bot was kicked") || r.includes("user is deactivated")) {
    return { ok: false, code: "bot-blocked" };
  }
  if (r.includes("chat not found") || r.includes("peer_id_invalid")) {
    return { ok: false, code: "invalid-chat" };
  }
  if (res.status === 429) return { ok: false, code: "rate-limited" };
  return { ok: false, code: "telegram-error" };
}

Deno.serve(async (req: Request): Promise<Response> => {
  const headers = corsHeaders(req.headers.get("Origin"));
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers });
  }
  if (req.method !== "POST") {
    return json(headers, 405, { error: "Method not allowed." });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const botToken = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
  if (supabaseUrl === "" || anonKey === "") {
    return json(headers, 500, { error: "Server misconfigured." });
  }
  if (botToken === "") {
    return json(headers, 503, { error: "Telegram bot is not configured on the server." });
  }

  const authHeader = req.headers.get("Authorization") ?? "";
  const supabase = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });
  const { data: userData, error: userError } = await supabase.auth.getUser();
  const user = userData?.user ?? null;
  if (userError || !user) {
    return json(headers, 401, { error: "Sign in required." });
  }

  const { data } = await supabase
    .from("telegram_connections")
    .select("telegram_chat_id,enabled")
    .eq("user_id", user.id)
    .maybeSingle();
  const conn = data as { telegram_chat_id: string; enabled: boolean } | null;
  if (!conn) {
    return json(headers, 404, { error: "not-connected" });
  }
  if (!conn.enabled) {
    return json(headers, 403, { error: "disabled" });
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return json(headers, 400, { error: "Invalid JSON body." });
  }

  // Self-test template (never a real trading signal).
  if (body.test === true) {
    const flags = (typeof body.flags === "object" && body.flags !== null ? body.flags : {}) as Record<string, unknown>;
    const on = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);
    const text = [
      "🔔 Telegram Connected",
      "",
      "CryptoIn notifications are working.",
      "",
      `Crypto: ${on(flags.crypto, true) ? "ON" : "OFF"}`,
      `Stocks: ${on(flags.stocks, true) ? "ON" : "OFF"}`,
      `Commodities: ${on(flags.commodities, true) ? "ON" : "OFF"}`,
    ].join("\n");
    const sent = await telegramSend(botToken, conn.telegram_chat_id, text, null);
    if (!sent.ok) return json(headers, 502, { error: sent.code });
    return json(headers, 200, { ok: true });
  }

  const message = typeof body.message === "string" ? body.message : "";
  if (message.trim().length === 0 || message.length > MAX_MESSAGE) {
    return json(headers, 400, { error: "Invalid message." });
  }
  const url = cleanUrl(body.url);
  const sent = await telegramSend(botToken, conn.telegram_chat_id, message, url);
  if (!sent.ok) return json(headers, 502, { error: sent.code });
  return json(headers, 200, { ok: true });
});
