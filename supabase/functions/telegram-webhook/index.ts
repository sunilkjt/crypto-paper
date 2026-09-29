// Supabase Edge Function: telegram-webhook (Deno).
//
// Receives Telegram Bot API updates (no user JWT — Telegram servers call
// this). Gateway JWT verification MUST be OFF for this function; security
// comes from one-time high-entropy start tokens, not from caller auth:
//
//   User taps t.me/<bot>?start=<token>  ->  Telegram POSTs an update with
//   message.text == "/start <token>"     ->  token must exist, be unexpired
//   and unused, else the update is ignored (always HTTP 200, no oracle).
//
// On success the chat is linked to the token owner's account and the token
// is burned. /stop disables the link. Uses the service role server-side
// (regular RLS cannot apply without a user JWT here).
//
// Deploy: supabase functions deploy telegram-webhook
// Secrets: TELEGRAM_BOT_TOKEN (server-side only, never returned)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.2";

interface TelegramUpdate {
  message?: {
    chat?: { id?: number | string; username?: string };
    from?: { username?: string };
    text?: string;
  };
}

async function botSend(botToken: string, chatId: string, text: string): Promise<void> {
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 1000) }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // best effort
  }
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
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  let update: TelegramUpdate;
  try {
    update = (await req.json()) as TelegramUpdate;
  } catch {
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  const text = update.message?.text ?? "";
  const chatId = update.message?.chat?.id;
  if (chatId === undefined || chatId === null) {
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  const chat = String(chatId);
  const username =
    update.message?.from?.username ?? update.message?.chat?.username ?? null;

  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  // /stop from Telegram disables the link (chat-owned action).
  if (text === "/stop" || text.startsWith("/stop ")) {
    await admin.from("telegram_connections").update({ enabled: false }).eq("telegram_chat_id", chat);
    await botSend(botToken, chat, "CryptoIn notifications paused for this chat. Reconnect anytime from the website.");
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Only /start <token> links a chat. Anything else is ignored silently.
  const match = /^\/start\s+([0-9a-fA-F]{16,128})\s*$/.exec(text.trim());
  if (!match) {
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  const token = match[1].toLowerCase();

  const { data } = await admin
    .from("telegram_connect_tokens")
    .select("user_id,expires_at,used_at")
    .eq("token", token)
    .maybeSingle();
  const row = data as { user_id: string; expires_at: string; used_at: string | null } | null;
  const valid =
    row !== null && row.used_at === null && Date.parse(row.expires_at) > Date.now();
  if (!valid) {
    await botSend(
      botToken,
      chat,
      "That connection link expired or was already used. Please generate a fresh one on the website (Settings → Telegram → Connect).",
    );
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  await admin.from("telegram_connections").upsert(
    {
      user_id: row.user_id,
      telegram_chat_id: chat,
      telegram_username: username,
      enabled: true,
    },
    { onConflict: "user_id" },
  );
  await admin.from("telegram_connect_tokens").update({ used_at: new Date().toISOString() }).eq("token", token);
  // Hygiene: drop the user's other spent/expired tokens.
  await admin.from("telegram_connect_tokens").delete().eq("user_id", row.user_id).neq("token", token);

  await botSend(
    botToken,
    chat,
    "✅ CryptoIn connected! Paper-signal notifications for your enabled categories will arrive here. Send /stop anytime to pause.",
  );
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
