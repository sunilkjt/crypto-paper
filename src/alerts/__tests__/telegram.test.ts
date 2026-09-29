import { describe, expect, it } from "vitest";
import {
  analysisUrl,
  formatTelegramMessage,
  TelegramNotificationProvider,
} from "../providers";
import {
  __setAlertSettingsStorageForTests,
  DEFAULT_ALERT_SETTINGS,
  saveAlertSettings,
} from "../settings";
import type { SignalEvent } from "../events";

function memoryStorage(): Storage {
  const store: Record<string, string> = {};
  return {
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => {
      store[k] = v;
    },
    removeItem: (k: string) => {
      delete store[k];
    },
    clear: () => {
      for (const k of Object.keys(store)) delete store[k];
    },
    key: (i: number) => Object.keys(store)[i] ?? null,
    get length() {
      return Object.keys(store).length;
    },
  } as Storage;
}

function event(
  over: Partial<SignalEvent> & { symbol: string; direction: "LONG" | "SHORT" },
): SignalEvent {
  // Category as the monitor pipeline sets it (explicit at emission).
  const category = over.category ?? ("crypto" as const);
  return {
    id: `${over.symbol}-${over.direction}-NEW`,
    type: "NEW_SIGNAL",
    setupType: "TREND",
    timeframe: "15m",
    previousStrength: null,
    currentStrength: 84,
    detail: null,
    status: "NEW",
    timestamp: 1000,
    signal: {
      entryLow: 182.2,
      entryHigh: 182.4,
      invalidation: 179.8,
      tp1: 187,
      tp2: 189.5,
      tp3: 192,
      riskReward: 2,
      reasons: ["Momentum recovering"],
      warnings: [],
    } as never,
    watched: false,
    read: false,
    category,
    ...over,
  };
}

describe("telegram message format (all six category/direction combos)", () => {
  const cases: {
    symbol: string;
    direction: "LONG" | "SHORT";
    category: "crypto" | "stocks" | "commodities";
    cat: string;
    arrow: string;
  }[] = [
    { symbol: "BTC", direction: "LONG", category: "crypto", cat: "CRYPTO", arrow: "📈" },
    { symbol: "ETH", direction: "SHORT", category: "crypto", cat: "CRYPTO", arrow: "📉" },
    { symbol: "xyz:AAPL", direction: "LONG", category: "stocks", cat: "STOCK", arrow: "📈" },
    { symbol: "xyz:TSLA", direction: "SHORT", category: "stocks", cat: "STOCK", arrow: "📉" },
    { symbol: "xyz:GOLD", direction: "LONG", category: "commodities", cat: "COMMODITY", arrow: "📈" },
    { symbol: "xyz:OIL", direction: "SHORT", category: "commodities", cat: "COMMODITY", arrow: "📉" },
  ];
  for (const c of cases) {
    it(`${c.cat} ${c.direction} ${c.symbol}`, () => {
      const msg = formatTelegramMessage(
        event({ symbol: c.symbol, direction: c.direction, currentStrength: 84, category: c.category }),
      );
      const [head] = msg.split("\n");
      expect(head).toContain(c.arrow);
      expect(head).toContain(c.cat);
      expect(head).toContain(c.direction);
      for (const needle of [
        c.symbol,
        "Score: 84/100",
        "Entry:",
        "Stop Loss:",
        "TP1:",
        "TP2:",
        "TP3:",
        "R:R:",
        "Timeframe: 15m",
        "Reasons:",
        "not a probability",
      ]) {
        expect(msg).toContain(needle);
      }
    });
  }

  it("derives legacy crypto symbols without a stored category", () => {
    const msg = formatTelegramMessage(event({ symbol: "OP", direction: "LONG", category: undefined }));
    expect(msg.split("\n")[0]).toContain("CRYPTO");
  });

  it("carries zero secret material", () => {
    const msg = formatTelegramMessage(event({ symbol: "xyz:AAPL", direction: "LONG" }));
    expect(msg).not.toMatch(/TELEGRAM_BOT_TOKEN|VITE_TELEGRAM|sb_secret|service_role|GROQ_API_KEY|GEMINI_API_KEY/i);
  });
});

describe("telegram provider delivery", () => {
  it("POSTs message + url + session JWT, never any token", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;
    const tg = new TelegramNotificationProvider("https://edge.example.test/telegram-notify", {
      getSessionToken: async () => "user-jwt-123",
      fetchFn,
    });
    tg.notify(event({ symbol: "xyz:AAPL", direction: "LONG", category: "stocks" }));
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.url).toBe("https://edge.example.test/telegram-notify");
    expect(call.init.method).toBe("POST");
    const headers = call.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer user-jwt-123");
    const body = JSON.parse(String(call.init.body)) as Record<string, unknown>;
    expect(typeof body.message).toBe("string");
    expect(String(body.message)).toContain("STOCK");
    expect(String(body.url)).toContain("#/coin/xyz:AAPL");
    expect(body.symbol).toBe("xyz:AAPL");
    expect(body.direction).toBe("LONG");
    expect(JSON.stringify(body)).not.toMatch(/TELEGRAM_BOT_TOKEN|sb_secret|service_role|gsk_|AIza|sb_publishable/i);
  });

  it("sends nothing without a session (logged out)", async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls += 1;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const tg = new TelegramNotificationProvider("https://edge.example.test/telegram-notify", {
      getSessionToken: async () => null,
      fetchFn,
    });
    tg.notify(event({ symbol: "BTC", direction: "LONG" }));
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toBe(0);
  });

  it("isAvailable combines endpoint, master switch and never throws", () => {
    __setAlertSettingsStorageForTests(memoryStorage());
    expect(new TelegramNotificationProvider("").isAvailable()).toBe(false);
    // Endpoint set but master switch defaults off.
    expect(new TelegramNotificationProvider("https://edge.example.test/x").isAvailable()).toBe(false);
    saveAlertSettings({ ...DEFAULT_ALERT_SETTINGS, telegramNotifications: true });
    expect(new TelegramNotificationProvider("https://edge.example.test/x").isAvailable()).toBe(true);
    __setAlertSettingsStorageForTests(null);
  });

  it("analysisUrl preserves symbol case for dex-prefixed markets", () => {
    expect(analysisUrl("xyz:NVDA")).toContain("#/coin/xyz:NVDA");
  });
});
