import { useCallback, useEffect, useState } from "react";
import { getSupabase } from "./client";
import { useAuth } from "./auth";

function supabaseUrl(): string {
  try {
    const v = (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_SUPABASE_URL;
    return typeof v === "string" ? v.trim().replace(/\/$/, "") : "";
  } catch {
    return "";
  }
}

function publishableKey(): string {
  try {
    const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
    return (env?.VITE_SUPABASE_PUBLISHABLE_KEY ?? env?.VITE_SUPABASE_ANON_KEY ?? "").trim();
  } catch {
    return "";
  }
}

export function telegramFunctionsAvailable(): boolean {
  return supabaseUrl() !== "" && publishableKey() !== "";
}

async function sessionToken(): Promise<string | null> {
  try {
    const sb = getSupabase();
    if (!sb) return null;
    const { data } = await sb.auth.getSession();
    return data.session?.access_token ?? null;
  } catch {
    return null;
  }
}

async function callEdge<T>(fn: string, body: Record<string, unknown>): Promise<T> {
  const base = supabaseUrl();
  const key = publishableKey();
  if (!base || !key) throw new Error("Cloud sync is not configured.");
  const token = await sessionToken();
  if (!token) throw new Error("Sign in required.");
  const res = await fetch(`${base}/functions/v1/${fn}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: key,
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  let payload: unknown = null;
  try {
    payload = await res.json();
  } catch {
    // fall through to error mapping below
  }
  if (!res.ok) {
    const msg =
      payload !== null && typeof payload === "object" && "error" in payload
        ? String((payload as { error: unknown }).error)
        : `Request failed (HTTP ${res.status}).`;
    throw new Error(msg);
  }
  return payload as T;
}

export interface TelegramStatus {
  connected: boolean;
  username: string | null;
  enabled: boolean;
  botUsername: string;
  botConfigured: boolean;
}

export interface TelegramToken {
  token: string;
  deepLink: string;
  expiresInSec: number;
}

export interface TelegramFlags {
  crypto: boolean;
  stocks: boolean;
  commodities: boolean;
}

export async function fetchTelegramStatus(): Promise<TelegramStatus> {
  return callEdge<TelegramStatus>("telegram-link", { action: "status" });
}

export async function createTelegramToken(): Promise<TelegramToken> {
  return callEdge<TelegramToken>("telegram-link", { action: "create-token" });
}

export async function disconnectTelegram(): Promise<{ ok: boolean }> {
  return callEdge<{ ok: boolean }>("telegram-link", { action: "disconnect" });
}

export async function sendTelegramTest(flags: TelegramFlags): Promise<{ ok: boolean }> {
  return callEdge<{ ok: boolean }>("telegram-notify", { test: true, flags });
}

export type TelegramConnState =
  | { phase: "signed-out" }
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "ready"; status: TelegramStatus };

/**
 * Telegram pairing state for Settings. Signed-out users get a prompt to log
 * in first (tokens are bound to the Supabase user).
 */
export function useTelegramConnection() {
  const { user, configured } = useAuth();
  const [state, setState] = useState<TelegramConnState>({ phase: "loading" });
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!configured || !telegramFunctionsAvailable()) {
      setState({ phase: "error", message: "Cloud sync is not configured." });
      return;
    }
    if (!user) {
      setState({ phase: "signed-out" });
      return;
    }
    setState({ phase: "loading" });
    try {
      const status = await fetchTelegramStatus();
      setState({ phase: "ready", status });
    } catch (e) {
      setState({ phase: "error", message: e instanceof Error ? e.message : "Could not load Telegram status." });
    }
  }, [configured, user]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = useCallback(
    async <T,>(fn: () => Promise<T>): Promise<T | null> => {
      setBusy(true);
      try {
        return await fn();
      } catch (e) {
        setState({ phase: "error", message: e instanceof Error ? e.message : "Request failed." });
        return null;
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const connect = useCallback(async (): Promise<TelegramToken | null> => {
    const out = await run(() => createTelegramToken());
    return out;
  }, [run]);

  const disconnect = useCallback(async (): Promise<boolean> => {
    const out = await run(() => disconnectTelegram());
    if (out) await refresh();
    return out !== null;
  }, [run, refresh]);

  const sendTest = useCallback(
    async (flags: TelegramFlags): Promise<boolean> => {
      const out = await run(() => sendTelegramTest(flags));
      return out !== null;
    },
    [run],
  );

  return { state, busy, refresh, connect, disconnect, sendTest };
}
