import { eventCategoryLabel, eventMessage, resolveEventCategory, type SignalEvent } from "./events";
import { loadAlertSettings } from "./settings";
import { fingerprintOf } from "./cooldown";
import { claimDelivery, releaseDeliveryClaim } from "../supabase/claims";

/** Injectable claim transport for tests (defaults hit the shared atomic gate). */
export interface ClaimDeps {
  claimDelivery?: (fingerprint: string, cooldownMs: number) => Promise<boolean | null>;
  releaseClaim?: (fingerprint: string) => Promise<void>;
}

function eventFingerprint(event: SignalEvent): string {
  return fingerprintOf({
    type: event.type,
    category: resolveEventCategory(event),
    symbol: event.symbol,
    direction: event.direction,
    timeframe: event.timeframe,
    entryLow: event.signal.entryLow,
    entryHigh: event.signal.entryHigh,
    strength: event.currentStrength,
  });
}

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
  private readonly claims: Required<ClaimDeps>;

  constructor(claims: ClaimDeps = {}) {
    this.claims = {
      claimDelivery: claims.claimDelivery ?? claimDelivery,
      releaseClaim: claims.releaseClaim ?? releaseDeliveryClaim,
    };
  }

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
    // Atomic cross-worker claim first: another tab/cron holding this fact
    // suppresses us; transport failure falls back to immediate delivery
    // (pre-atomic behavior preserved exactly when offline/unconfigured).
    void (async () => {
      const fp = eventFingerprint(event);
      const cooldownMs = loadAlertSettings().cooldownMs;
      try {
        const claimed = await this.claims.claimDelivery(fp, cooldownMs).catch(() => null);
        if (claimed === false) return;
      } catch {
        // fall through to delivery
      }
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
        try {
          await this.claims.releaseClaim(fp).catch(() => undefined);
        } catch {
          // ignore
        }
      }
    })();
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

/**
 * Build the coin-analysis URL for a symbol (HashRouter-safe, shared by the
 * browser and Telegram providers). Symbol case is preserved as-is.
 */
export function analysisUrl(symbol: string): string {
  try {
    return `${window.location.origin}${window.location.pathname}#/coin/${symbol.trim()}`;
  } catch {
    return `#/coin/${symbol.trim()}`;
  }
}

/** Telegram message format for secure-backend delivery (plain text only). */
export function formatTelegramMessage(event: SignalEvent): string {
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

export interface TelegramStatus {
  configured: boolean;
  label: "Connected" | "Not configured";
}

export interface TelegramDeps {
  /** Supabase session JWT for the delivery endpoint (never a bot token). */
  getSessionToken?: () => Promise<string | null>;
  fetchFn?: typeof fetch;
  openUrl?: (url: string) => void;
  claimDelivery?: ClaimDeps["claimDelivery"];
  releaseClaim?: ClaimDeps["releaseClaim"];
}

async function defaultSessionToken(): Promise<string | null> {
  try {
    const { getSupabase } = await import("../supabase/client");
    const sb = getSupabase();
    if (!sb) return null;
    const { data } = await sb.auth.getSession();
    return data.session?.access_token ?? null;
  } catch {
    return null;
  }
}

/**
 * Telegram delivery via the secure edge-function endpoint. The browser sends
 * ONLY the formatted message + analysis URL + the user's session JWT; the
 * chat_id always comes from the stored connection server-side and the bot
 * token never leaves the server. Without an endpoint it reports Not
 * configured and drops (never throws, never fabricates delivery).
 */
export class TelegramNotificationProvider implements NotificationProvider {
  readonly name = "telegram" as const;
  private readonly endpoint: string;
  private readonly deps: Required<TelegramDeps>;

  constructor(endpoint = "", deps: TelegramDeps = {}) {
    this.endpoint = endpoint.trim();
    this.deps = {
      getSessionToken: deps.getSessionToken ?? defaultSessionToken,
      fetchFn: deps.fetchFn ?? fetch,
      openUrl: deps.openUrl ?? ((url: string) => window.open(url, "_blank")?.focus()),
      claimDelivery: deps.claimDelivery ?? claimDelivery,
      releaseClaim: deps.releaseClaim ?? releaseDeliveryClaim,
    };
  }

  status(): TelegramStatus {
    return this.endpoint === ""
      ? { configured: false, label: "Not configured" }
      : { configured: true, label: "Connected" };
  }

  /** Endpoint configured AND the Telegram master switch on in settings. */
  isAvailable(): boolean {
    if (this.endpoint === "") return false;
    try {
      return loadAlertSettings().telegramNotifications === true;
    } catch {
      return false;
    }
  }

  notify(event: SignalEvent): void {
    if (this.endpoint === "") return;
    const message = formatTelegramMessage(event);
    const url = analysisUrl(event.symbol);
    void (async () => {
      const fp = eventFingerprint(event);
      let cooldownMs = 1_800_000;
      try {
        cooldownMs = loadAlertSettings().cooldownMs;
      } catch {
        // fall back to the default window
      }
      const release = async () => {
        try {
          await this.deps.releaseClaim(fp).catch(() => undefined);
        } catch {
          // ignore
        }
      };
      try {
        const token = await this.deps.getSessionToken();
        if (!token) return;
        try {
          const claimed = await this.deps.claimDelivery(fp, cooldownMs).catch(() => null);
          if (claimed === false) return; // another worker won this fact
        } catch {
          // fall through to delivery (fail-open preserves offline behavior)
        }
        const res = await this.deps.fetchFn(this.endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ message, url, symbol: event.symbol, direction: event.direction }),
        }).catch(() => undefined);
        if (!res || !res.ok) {
          // Failed send must not read as delivered: release the claim so a
          // later attempt may proceed instead of being cooldown-suppressed.
          await release();
        }
      } catch {
        await release();
      }
    })();
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
