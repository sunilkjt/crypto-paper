import { eventCategoryLabel, eventMessage, type SignalEvent } from "./events";

/**
 * NotificationProvider abstraction — future providers plug in here:
 * Browser (Notification API), Telegram (via secure backend), Email.
 * Secrets NEVER live here: Telegram delivery goes through a caller-owned
 * https endpoint that holds the bot token server-side.
 */

export interface NotificationProvider {
  readonly name: "browser" | "telegram" | "email" | "sound";
  isAvailable(): boolean;
  notify(event: SignalEvent): void;
}

function eventUrl(symbol: string): string {
  // Hash-routed coin page; works from notification clicks on Pages.
  return `${window.location.origin}${window.location.pathname}#/coin/${symbol}`;
}

/** Browser notifications: permission asked ONLY on explicit enable. */
export class BrowserNotificationProvider implements NotificationProvider {
  readonly name = "browser" as const;

  isAvailable(): boolean {
    try {
      return typeof Notification !== "undefined" && Notification.permission === "granted";
    } catch {
      return false;
    }
  }

  async requestPermission(): Promise<boolean> {
    try {
      if (typeof Notification === "undefined") return false;
      const result = await Notification.requestPermission();
      return result === "granted";
    } catch {
      return false;
    }
  }

  notify(event: SignalEvent): void {
    if (!this.isAvailable()) return;
    try {
      const s = event.signal;
      const cat = eventCategoryLabel(event);
      const arrow = event.direction === "LONG" ? "📈" : "📉";
      const n = new Notification(`${arrow} ${cat} ${event.direction} — ${event.symbol}`, {
        body:
          `Score ${event.currentStrength}\n` +
          `Entry: ${s.entryLow ?? "—"} – ${s.entryHigh ?? "—"}\n` +
          `SL: ${s.invalidation ?? "—"} · TP1: ${s.tp1 ?? "—"}\n` +
          `R:R ${s.riskReward ?? "—"}`,
        tag: event.id,
      });
      n.onclick = () => {
        try {
          window.open(eventUrl(event.symbol), "_blank")?.focus();
        } catch {
          // ignore
        }
        n.close();
      };
    } catch {
      // notifications must never break the app
    }
  }
}

/** Optional sound alerts — WebAudio beep, no assets, off unless enabled. */
export class SoundAlertProvider implements NotificationProvider {
  readonly name = "sound" as const;
  private enabled = false;

  setEnabled(on: boolean): void {
    this.enabled = on;
  }

  isAvailable(): boolean {
    return this.enabled && typeof window !== "undefined" && typeof window.AudioContext !== "undefined";
  }

  notify(_event: SignalEvent): void {
    void _event;
    if (!this.isAvailable()) return;
    try {
      const Ctor = window.AudioContext;
      const ctx = new Ctor();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.value = 880;
      gain.gain.value = 0.08;
      osc.start();
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35);
      osc.stop(ctx.currentTime + 0.4);
      window.setTimeout(() => void ctx.close().catch(() => undefined), 600);
    } catch {
      // ignore
    }
  }
}

/** Telegram message format for future secure-backend delivery. */
export function formatTelegramMessage(event: SignalEvent): string {
  const s = event.signal;
  const lines = [
    `🚨 NEW ${eventCategoryLabel(event)} SIGNAL`,
    "",
    event.symbol,
    event.direction,
    "",
    "Signal strength:",
    `${event.currentStrength}/100`,
    "",
    "Entry:",
    `${s.entryLow ?? "—"} – ${s.entryHigh ?? "—"}`,
    "",
    "Invalidation:",
    `${s.invalidation ?? "—"}`,
    "",
    "TP1:",
    `${s.tp1 ?? "—"}`,
    "",
    "TP2:",
    `${s.tp2 ?? "—"}`,
    "",
    "TP3:",
    `${s.tp3 ?? "—"}`,
    "",
    "R:R:",
    `${s.riskReward ?? "—"}`,
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

export interface TelegramStatus {
  configured: boolean;
  label: "Connected" | "Not configured";
}

/**
 * Telegram delivery stub: WITHOUT a backend endpoint it reports
 * Not configured and drops (never throws, never fabricates delivery).
 * WITH VITE_TELEGRAM_ENDPOINT it POSTs { message } server-side.
 */
export class TelegramNotificationProvider implements NotificationProvider {
  readonly name = "telegram" as const;
  private readonly endpoint: string;

  constructor(endpoint = "") {
    this.endpoint = endpoint.trim();
  }

  status(): TelegramStatus {
    return this.endpoint === ""
      ? { configured: false, label: "Not configured" }
      : { configured: true, label: "Connected" };
  }

  isAvailable(): boolean {
    return this.endpoint !== "";
  }

  notify(event: SignalEvent): void {
    if (!this.isAvailable()) return;
    const message = formatTelegramMessage(event);
    void fetch(this.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, symbol: event.symbol, direction: event.direction }),
    }).catch(() => undefined);
  }
}

export function telegramEndpointFromEnv(): string {
  try {
    const v = (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_TELEGRAM_ENDPOINT;
    return typeof v === "string" ? v.trim() : "";
  } catch {
    return "";
  }
}
