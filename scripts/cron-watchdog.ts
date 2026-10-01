/**
 * Independent watchdog for the 24/7 signal cron (no browser, no scans).
 * Reads the scanner heartbeat, alerts linked Telegram chats on staleness,
 * sends one recovery message when service resumes. Usage: npm run scan:watchdog
 */

import { createSupabaseStateStore } from "../src/cron/state.js";
import { createTelegramSender } from "../src/cron/notify.js";
import { listEnabledChats } from "../src/cron/chats.js";
import { checkOnce, type WatchdogHeartbeat } from "../src/cron/watchdog.js";

function required(name: string): string {
  const v = (process.env[name] ?? "").trim();
  if (!v) {
    console.error(`Missing required env ${name}.`);
    process.exit(2);
  }
  return v;
}

function asHeartbeat(v: unknown): WatchdogHeartbeat | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  const lastRun = (o.lastRun ?? null) as {
    at?: unknown;
    perCategory?: unknown;
    lastDeliveryAt?: unknown;
  } | null;
  if (lastRun === null || typeof lastRun !== "object") return null;
  const perCategory: WatchdogHeartbeat["perCategory"] = {};
  const raw = (lastRun.perCategory ?? {}) as Record<string, unknown>;
  for (const [k, c] of Object.entries(raw)) {
    const cc = (c ?? {}) as Record<string, unknown>;
    perCategory[k] = {
      universe: typeof cc.universe === "number" ? cc.universe : 0,
      scanned: typeof cc.scanned === "number" ? cc.scanned : 0,
      signals: typeof cc.signals === "number" ? cc.signals : 0,
    };
  }
  return {
    lastRunAt: typeof lastRun.at === "number" ? lastRun.at : null,
    perCategory,
    lastDeliveryAt: typeof lastRun.lastDeliveryAt === "number" ? lastRun.lastDeliveryAt : null,
  };
}

async function main(): Promise<void> {
  const supabaseUrl = required("SUPABASE_URL");
  const serviceKey = required("SUPABASE_SERVICE_ROLE_KEY");
  const botToken = required("TELEGRAM_BOT_TOKEN");
  const staleAfterMs = Math.max(60_000, (Number(process.env.SCANNER_HEARTBEAT_MAX_AGE_MINUTES ?? "20") || 20) * 60_000);
  const log = (msg: string) => console.log(`[watchdog] ${msg}`);
  log(`staleAfterMin=${staleAfterMs / 60_000}`);

  const store = createSupabaseStateStore({ url: supabaseUrl, serviceKey });
  const sender = createTelegramSender({ token: botToken });

  const report = await checkOnce({
    now: Date.now(),
    staleAfterMs,
    loadHeartbeat: async () => asHeartbeat(await store.loadValue("cron-monitor")),
    loadAlertState: async () => {
      const v = (await store.loadValue("watchdog")) as { alertedAt?: unknown } | null;
      return { alertedAt: typeof v?.alertedAt === "number" ? v.alertedAt : null };
    },
    saveAlertState: (s) => store.saveValue("watchdog", s),
    deliverAlert: async (text: string) => {
      const chats = await listEnabledChats({ url: supabaseUrl, serviceKey });
      if (chats.length === 0) {
        log("no chats linked; nothing to notify");
        return true;
      }
      let ok = 0;
      for (const chat of chats) {
        const res = await sender.send(chat, text, null);
        if (res.ok) ok += 1;
        else log(`delivery to ****${chat.slice(-4)} failed (${res.code})`);
      }
      return ok > 0;
    },
    log,
  });

  console.log(`[watchdog] report ${JSON.stringify(report)}`);
}

main().catch((e: unknown) => {
  console.error(`[watchdog] fatal: ${e instanceof Error ? e.message : "unknown"}`);
  process.exit(1);
});
