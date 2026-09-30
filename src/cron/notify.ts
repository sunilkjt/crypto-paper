import { formatTelegramMessage } from "../alerts/providers";
import type { SignalEvent } from "../alerts/events";

/**
 * Cron Telegram delivery: direct Bot API calls (the cron authenticates as
 * itself with the server-side bot token — there is no user session in CI).
 * Message text reuses the shared formatter; NO AI layer is involved.
 */

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export interface TelegramSender {
  send: (chatId: string, text: string, url: string | null) => Promise<{ ok: boolean; code: string }>;
}

export function createTelegramSender(opts: { token: string; fetchFn?: FetchFn }): TelegramSender {
  const run = opts.fetchFn ?? fetch;
  return {
    async send(chatId: string, text: string, url: string | null) {
      const payload: Record<string, unknown> = { chat_id: chatId, text: text.slice(0, 3500) };
      if (url) {
        payload.reply_markup = { inline_keyboard: [[{ text: "View Analysis", url }]] };
      }
      try {
        const res = await run(`https://api.telegram.org/bot${opts.token}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (res.ok) return { ok: true, code: "sent" };
        return { ok: false, code: `http-${res.status}` };
      } catch {
        return { ok: false, code: "network" };
      }
    },
  };
}

/** Absolute analysis URL for the inline button (route architecture reused). */
export function analysisUrlFor(siteUrl: string, symbol: string): string {
  return `${siteUrl.replace(/\/$/, "")}/#/coin/${symbol.trim()}`;
}

export interface DeliveryReport {
  delivered: number;
  failed: number;
}

/**
 * Deliver events to every linked chat. Per-event/per-chat isolation: one
 * bad chat never blocks the rest. Returns counts for CI logs.
 */
export async function deliverEvents(
  events: SignalEvent[],
  chats: string[],
  sender: TelegramSender,
  siteUrl: string,
  log: (msg: string) => void = () => {},
): Promise<DeliveryReport> {
  let delivered = 0;
  let failed = 0;
  for (const e of events) {
    const message = formatTelegramMessage(e);
    const url = analysisUrlFor(siteUrl, e.symbol);
    for (const chat of chats) {
      const res = await sender.send(chat, message, url);
      if (res.ok) {
        delivered += 1;
      } else {
        failed += 1;
        log(`delivery failed ${e.symbol} -> chat ****${chat.slice(-4)} (${res.code})`);
      }
    }
  }
  return { delivered, failed };
}
