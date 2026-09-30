import { describe, expect, it } from "vitest";
import { analysisUrlFor, createTelegramSender, deliverEvents } from "../notify";
import type { SignalEvent } from "../../alerts/events";

function event(symbol: string, direction: "LONG" | "SHORT"): SignalEvent {
  return {
    id: `${symbol}-${direction}`,
    type: "NEW_SIGNAL",
    symbol,
    direction,
    setupType: "TREND",
    timeframe: "15m",
    previousStrength: null,
    currentStrength: 84,
    detail: null,
    status: "NEW",
    timestamp: 1000,
    signal: {
      entryLow: 100,
      entryHigh: 101,
      invalidation: 95,
      tp1: 110,
      tp2: 115,
      tp3: 120,
      riskReward: 2,
      reasons: ["r"],
      warnings: [],
    } as never,
    watched: false,
    read: false,
    category: symbol.includes(":") ? "stocks" : "crypto",
  };
}

describe("cron telegram delivery", () => {
  it("builds absolute analysis URLs from the site base", () => {
    expect(analysisUrlFor("https://sunilkjt.github.io/crypto-paper", "xyz:NVDA")).toBe(
      "https://sunilkjt.github.io/crypto-paper/#/coin/xyz:NVDA",
    );
    expect(analysisUrlFor("https://sunilkjt.github.io/crypto-paper/", "BTC")).toBe(
      "https://sunilkjt.github.io/crypto-paper/#/coin/BTC",
    );
  });

  it("sends category text + button, never the bot token", async () => {
    const posts: { url: string; body: Record<string, unknown> }[] = [];
    const sender = createTelegramSender({
      token: "real-bot-token",
      fetchFn: (async (url: string, init?: RequestInit) => {
        posts.push({ url, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }) as typeof fetch,
    });
    const report = await deliverEvents(
      [event("xyz:NVDA", "LONG")],
      ["111", "222"],
      sender,
      "https://sunilkjt.github.io/crypto-paper",
    );
    expect(report).toEqual({ delivered: 2, failed: 0 });
    expect(posts).toHaveLength(2);
    expect(posts[0].url).toContain("api.telegram.org");
    expect(String(posts[0].body.text)).toContain("STOCK");
    const markup = posts[0].body.reply_markup as { inline_keyboard: { text: string; url: string }[][] };
    expect(markup.inline_keyboard[0][0].text).toBe("View Analysis");
    expect(markup.inline_keyboard[0][0].url).toContain("#/coin/xyz:NVDA");
    // The token authenticates server-to-Telegram in the URL path (Bot API
    // design) — it must never appear in message bodies or button payloads.
    expect(posts[0].url.startsWith("https://api.telegram.org/bot")).toBe(true);
    for (const p of posts) {
      expect(JSON.stringify(p.body)).not.toContain("real-bot-token");
    }
  });

  it("isolates per-chat failures and counts them", async () => {
    let n = 0;
    const sender = createTelegramSender({
      token: "t",
      fetchFn: (async () => {
        n += 1;
        if (n === 1) throw new Error("boom");
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }) as typeof fetch,
    });
    const report = await deliverEvents([event("BTC", "SHORT")], ["bad", "good"], sender, "https://x.test");
    expect(report).toEqual({ delivered: 1, failed: 1 });
  });
});
