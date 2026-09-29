// Supabase Edge Function: telegram-link (Deno).
//
// Authenticated user actions for Telegram pairing. Gateway JWT verification
// stays ON: every action carries the caller's Supabase JWT and all DB access
// is RLS-scoped to auth.uid(). Nothing secret is ever returned.
//
//   POST { action: "status" }
//     -> { connected, username, enabled, botUsername }
//   POST { action: "create-token" }
//     -> { token, deepLink, expiresInSec } (single-use, 15 min)
//        Also (re)registers the Telegram webhook idempotently.
//   POST { action: "disconnect" }
//     -> { ok: true } (removes the caller's connection only)
//
// Deploy: supabase functions deploy telegram-link
// Secrets: TELEGRAM_BOT_TOKEN (never exposed), TELEGRAM_BOT_USERNAME (public)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.2";

const TOKEN_BYTES = 32;
const TOKEN_TTL_TEXT = "15 minutes";

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

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(TOKEN_BYTES));
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
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
  const botUsername = Deno.env.get("TELEGRAM_BOT_USERNAME") ?? "";
  if (supabaseUrl === "" || anonKey === "") {
    return json(headers, 500, { error: "Server misconfigured." });
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

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return json(headers, 400, { error: "Invalid JSON body." });
  }
  const action = body.action;

  if (action === "status") {
    const { data } = await supabase
      .from("telegram_connections")
      .select("telegram_username,enabled,connected_at")
      .eq("user_id", user.id)
      .maybeSingle();
    const row = data as { telegram_username: string | null; enabled: boolean; connected_at: string } | null;
    return json(headers, 200, {
      connected: row !== null,
      username: row?.telegram_username ?? null,
      enabled: row?.enabled ?? false,
      botUsername,
      botConfigured: botToken !== "" && botUsername !== "",
    });
  }

  if (action === "create-token") {
    if (botToken === "" || botUsername === "") {
      return json(headers, 503, { error: "Telegram bot is not configured on the server." });
    }
    const token = randomToken();
    const { error: insError } = await supabase.from("telegram_connect_tokens").insert({
      token,
      user_id: user.id,
    });
    if (insError) {
      return json(headers, 500, { error: "Could not create a connection token." });
    }
    // Idempotent webhook registration so /start updates reach telegram-webhook.
    try {
      await fetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: `${supabaseUrl}/functions/v1/telegram-webhook` }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      // Non-fatal: an already-registered webhook keeps working.
    }
    return json(headers, 200, {
      token,
      deepLink: `https://t.me/${botUsername}?start=${token}`,
      expiresInSec: 15 * 60,
      tokenTtl: TOKEN_TTL_TEXT,
    });
  }

  if (action === "disconnect") {
    await supabase.from("telegram_connections").delete().eq("user_id", user.id);
    await supabase.from("telegram_connect_tokens").delete().eq("user_id", user.id);
    return json(headers, 200, { ok: true });
  }

  return json(headers, 400, { error: "Unknown action." });
});
