// Supabase Edge Function: telegram-webhook (Deno).
//
// Receives Telegram Bot API updates (no user JWT — Telegram servers call
// this). Gateway JWT verification MUST be OFF. Two roles:
//
// PUSH (existing): /start <one-time-token> links the chat; /stop pauses.
// PULL (this feature): paired chats may query /help /status /signals
// /today /last /history — pure Supabase reads + formatting. /scan
// acknowledges immediately and hands off to the telegram-scan function
// (same deterministic engine, read-only: no history writes, no cooldown
// gate). The webhook itself NEVER scans, NEVER calls Hyperliquid
// directly, NEVER calls Groq/AI, NEVER trades.
//
// Security: unknown/expired tokens are ignored with HTTP 200 (no oracle);
// unpaired chats get the access message; DB errors map to a generic
// message; the bot token never leaves the server.
//
// Deploy: supabase functions deploy telegram-webhook
// Secrets: TELEGRAM_BOT_TOKEN (server-side only)

// ---- Inlined from ../_shared/commands.ts (dashboard deploys are single-file;
// ---- source of truth, unit-tested via vitest) ----
/**
 * Shared Telegram command logic: pure functions with NO Deno/Node APIs, so
 * this file is imported by BOTH the edge webhook (relative import) and the
 * vitest suite. The bot is READ-ONLY: parsing + formatting only, never
 * scans, never AI, never trades.
 */

export interface SignalRow {
  id: string;
  category: "crypto" | "stocks" | "commodities";
  symbol: string;
  direction: "LONG" | "SHORT";
  score: number;
  timeframe: string;
  entry_low: number | null;
  entry_high: number | null;
  invalidation: number | null;
  tp1: number | null;
  tp2: number | null;
  tp3: number | null;
  risk_reward: number | null;
  setup_type: string | null;
  status: string;
  first_seen: string;
  last_seen: string;
}

export type BotCommand =
  | { cmd: "start"; arg?: string }
  | { cmd: "stop" }
  | { cmd: "help" }
  | { cmd: "status" }
  | { cmd: "signals"; category?: "crypto" | "stocks" | "commodities" }
  | { cmd: "today" }
  | { cmd: "last"; symbol?: string }
  | { cmd: "history"; limit: number }
  | { cmd: "scan"; args: string }
  | { cmd: "performance"; category?: "crypto" | "stocks" | "commodities" }
  | { cmd: "unknown" };

export const UNPAIRED_MESSAGE =
  "🔒 Telegram is not connected to a CryptoIn account.\n\nOpen CryptoIn and connect Telegram first.";
export const SCAN_ACK_MESSAGE =
  "🔎 Scanning Hyperliquid markets...\n\nCrypto + Stocks + Commodities\nPlease wait...";
export const DB_ERROR_MESSAGE =
  "⚠️ I couldn't retrieve the signal history right now.\n\nPlease try again shortly.";
export const EMPTY_MESSAGE = "No qualifying signals found yet.";

const CAT_LABEL: Record<SignalRow["category"], string> = {
  crypto: "CRYPTO",
  stocks: "STOCK",
  commodities: "COMMODITY",
};

export function catLabel(category: SignalRow["category"]): string {
  return CAT_LABEL[category];
}

export function dirArrow(direction: SignalRow["direction"]): string {
  return direction === "LONG" ? "📈" : "📉";
}

function money(v: number | null): string {
  return typeof v === "number" && Number.isFinite(v) ? `${v}` : "—";
}

/** "18:05 UTC" (empty/Invalid safe). */
export function fmtTime(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  return `${new Date(t).toISOString().slice(11, 16)} UTC`;
}

/** "2026-09-30 18:05 UTC" (empty/Invalid safe). */
export function fmtDateTime(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  return `${new Date(t).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** Parse "/cmd arg" (tolerates @bot suffix, extra spaces, missing slash). */
export function parseCommand(text: string): BotCommand {
  const clean = text.trim().replace(/^\/+/, "");
  if (clean === "") return { cmd: "unknown" };
  const [rawCmd, ...rest] = clean.split(/\s+/);
  const cmd = rawCmd.split("@")[0].toLowerCase();
  const arg = rest.join(" ").trim();
  switch (cmd) {
    case "start":
      return { cmd: "start", arg: arg === "" ? undefined : arg };
    case "stop":
      return { cmd: "stop" };
    case "help":
      return { cmd: "help" };
    case "status":
      return { cmd: "status" };
    case "signals": {
      const c = arg.toLowerCase();
      if (c === "crypto" || c === "stocks" || c === "commodities") return { cmd: "signals", category: c };
      return { cmd: "signals" };
    }
    case "today":
      return { cmd: "today" };
    case "last":
      return { cmd: "last", symbol: arg === "" ? undefined : arg.toUpperCase() };
    case "history":
      return { cmd: "history", limit: clampHistoryLimit(Number.parseInt(arg, 10)) };
    case "scan":
      // Args pass through opaquely; the scan endpoint parses category /
      // direction / trade / limit (case-insensitive, combined).
      return { cmd: "scan", args: arg };
    case "performance": {
      const c = arg.toLowerCase();
      if (c === "crypto" || c === "stocks" || c === "commodities") return { cmd: "performance", category: c };
      return { cmd: "performance" };
    }
    default:
      return { cmd: "unknown" };
  }
}

/** History depth clamp: default 10, hard cap 50, minimum 1. */
export function clampHistoryLimit(n: number): number {
  if (!Number.isFinite(n)) return 10;
  return Math.min(50, Math.max(1, Math.floor(n)));
}

/**
 * Deterministic natural-language router. Plain keyword rules only — Groq is
 * never consulted. Returns a canonical command string or null (unknown).
 */
export function routeNatural(text: string): string | null {
  const t = text.toLowerCase().trim();
  if (t === "") return null;
  if (t.includes("status") || (t.includes("scanner") && t.includes("running"))) return "/status";
  if (t.includes("today")) {
    if (t.includes("stock")) return "/signals stocks";
    if (t.includes("commod")) return "/signals commodities";
    if (t.includes("crypto")) return "/signals crypto";
    return "/today";
  }
  const lastMatch = /(?:^|\s)last\s+([a-z0-9:.-]+)/.exec(t);
  if (lastMatch) {
    const token = lastMatch[1].replace(/[?.!]+$/, "").toUpperCase();
    if (token === "SIGNAL" || token === "SIGNALS" || token === "ONE") return "/last";
    if (token === "STOCK" || token === "STOCKS") return "/signals stocks";
    if (token === "COMMODITY" || token === "COMMODITIES") return "/signals commodities";
    if (token === "CRYPTO") return "/signals crypto";
    return `/last ${token}`;
  }
  const scanMatch = /(?:^|\s)scan(?:\s+(.*))?$/.exec(t);
  if (scanMatch) {
    const after = (scanMatch[1] ?? "").trim().replace(/[?.!]+$/, "");
    return after === "" ? "/scan" : `/scan ${after}`;
  }
  if (t.includes("performance") || t.includes("win rate") || t.includes("profit factor")) {
    if (t.includes("stock")) return "/performance stocks";
    if (t.includes("commod")) return "/performance commodities";
    if (t.includes("crypto")) return "/performance crypto";
    return "/performance";
  }
  if (t.includes("previous") || (t.includes("recent") && t.includes("signal"))) return "/signals";
  if (t.includes("stock")) return "/signals stocks";
  if (t.includes("commod")) return "/signals commodities";
  if (t.includes("crypto")) return "/signals crypto";
  if (t.includes("signal") || t.includes("history")) return "/signals";
  return null;
}

/**
 * DB symbol filter for /last lookups: exact match first, then dex-suffix
 * match (bare "AAPL" finds "xyz:AAPL"). Returns a PostgREST `or=` value or
 * null when the argument is unusable.
 */
export function symbolFilter(arg: string): string | null {
  const clean = arg.trim().toUpperCase().replace(/[^A-Z0-9:.-]/g, "");
  if (clean === "" || clean.length > 32) return null;
  if (clean.includes(":")) return `symbol.eq.${clean}`;
  return `or=(symbol.eq.${clean},symbol.like.*:${clean})`;
}

export function formatHelp(): string {
  return [
    "🤖 CryptoIn Bot",
    "",
    "Available commands:",
    "",
    "/status — Scanner status",
    "/signals — Latest signals",
    "/signals crypto — Latest Crypto signals",
    "/signals stocks — Latest Stock signals",
    "/signals commodities — Latest Commodity signals",
    "/today — Today's signals",
    "/last — Last signal",
    "/last BTC — Last signal for a symbol",
    "/history — Recent signal history",
    "",
    "🔎 MARKET SCAN",
    "",
    "/scan — Fresh scan of all markets",
    "/scan crypto — Crypto only",
    "/scan stocks — Stocks only",
    "/scan commodities — Commodities only",
    "/scan long — LONG setups",
    "/scan short — SHORT setups",
    "/scan trade — Qualified trades only",
    "/scan 10 — Top 10 setups",
    "",
    "Examples:",
    "/scan stocks long",
    "/scan crypto 5",
    "/scan trade 10",
    "",
    "📊 PERFORMANCE",
    "",
    "/performance — Signal performance",
    "/performance crypto — Crypto performance",
    "/performance stocks — Stock performance",
    "/performance commodities — Commodity performance",
    "",
    "/help — Show this help",
    "",
    "Read-only: I explain signals, I never trade.",
  ].join("\n");
}

export function formatSignalDetail(r: SignalRow): string {
  const entry =
    r.entry_low !== null && r.entry_high !== null
      ? `${money(r.entry_low)} – ${money(r.entry_high)}`
      : money(r.entry_low);
  return [
    `${dirArrow(r.direction)} ${catLabel(r.category)} ${r.direction}`,
    "",
    r.symbol,
    "",
    `Score: ${r.score}`,
    `Entry: ${entry}`,
    `SL: ${money(r.invalidation)}`,
    `TP1: ${money(r.tp1)}`,
    `TP2: ${money(r.tp2)}`,
    `R:R: ${r.risk_reward !== null ? `1 : ${r.risk_reward}` : "—"}`,
    "",
    `Timeframe: ${r.timeframe}`,
    "",
    fmtTime(r.last_seen),
  ].join("\n");
}

export function formatSignalLine(r: SignalRow, index: number): string {
  return `${index}. ${dirArrow(r.direction)} ${catLabel(r.category)} ${r.direction} — ${r.symbol}\n   Score ${r.score} — ${fmtTime(r.last_seen)}`;
}

export function formatSignalsList(rows: SignalRow[], title = "📊 LATEST SIGNALS"): string {
  if (rows.length === 0) return EMPTY_MESSAGE;
  return [title, ...rows.flatMap((r) => ["", formatSignalDetail(r)])].join("\n");
}

export interface TodayRow {
  rows: SignalRow[];
}

export function formatToday(rows: SignalRow[]): string {
  if (rows.length === 0) return EMPTY_MESSAGE;
  const count = (cat: SignalRow["category"], dir: SignalRow["direction"]) =>
    rows.filter((r) => r.category === cat && r.direction === dir).length;
  const head = [
    "📅 TODAY'S SIGNALS",
    "",
    "Crypto",
    "────────",
    `${count("crypto", "LONG")} LONG`,
    `${count("crypto", "SHORT")} SHORT`,
    "",
    "Stocks",
    "────────",
    `${count("stocks", "LONG")} LONG`,
    `${count("stocks", "SHORT")} SHORT`,
    "",
    "Commodities",
    "────────",
    `${count("commodities", "LONG")} LONG`,
    `${count("commodities", "SHORT")} SHORT`,
    "",
  ];
  const shown = rows.slice(0, 10);
  const tail = rows.length > 10 ? ["", "Showing latest 10 signals."] : [];
  return [...head, ...shown.flatMap((r) => ["", formatSignalDetail(r)]), ...tail].join("\n");
}

export interface Heartbeat {
  lastRunAt: number | null;
  perCategory: Record<string, { universe: number; scanned: number; signals: number }>;
  lastDeliveryAt: number | null;
  now: number;
  /** Paired Telegram username of the requester (shown, never secrets). */
  pairingUsername?: string | null;
  /** Latest signal_history timestamp the bot can serve. */
  lastSignalAt?: string | null;
  /** Today's per-category signal counts. */
  todayCounts?: { crypto: number; stocks: number; commodities: number };
  /** Watchdog alert state: true = alerting, false = armed, null = unknown. */
  watchdogAlerting?: boolean | null;
  /** Outcome-resolver heartbeat (written by the resolve job, null = never reported). */
  resolver?: { at: number; checked: number; resolved: number } | null;
}

/** ONLINE only from a fresh heartbeat — never from mere DB existence. */
export function formatStatus(h: Heartbeat): string {
  const STALE_AFTER_MS = 15 * 60_000;
  const online = h.lastRunAt !== null && h.now - h.lastRunAt <= STALE_AFTER_MS;
  const wd =
    h.watchdogAlerting === true
      ? "⚠ ALERTING"
      : h.watchdogAlerting === false
        ? "ARMED"
        : "UNKNOWN";
  const today = h.todayCounts;
  const lines = [
    `${online ? "🟢" : "🟠"} CryptoIn Scanner`,
    "",
    `Status: ${online ? "ONLINE" : "Scanner may be delayed"}`,
    "",
    `Last scan: ${h.lastRunAt === null ? "—" : fmtTime(new Date(h.lastRunAt).toISOString())}`,
    ...(h.lastSignalAt ? [`Last signal: ${fmtDateTime(h.lastSignalAt)}`] : []),
    "",
  ];
  for (const cat of ["crypto", "stocks", "commodities"] as const) {
    const c = h.perCategory[cat];
    const label = cat === "crypto" ? "Crypto" : cat === "stocks" ? "Stocks" : "Commodities";
    lines.push(`${label}: ${c ? `${c.universe} markets` : "—"}`);
    lines.push("");
  }
  if (today) {
    lines.push("Signals today:");
    lines.push(`Crypto: ${today.crypto}`);
    lines.push(`Stocks: ${today.stocks}`);
    lines.push(`Commodities: ${today.commodities}`);
    lines.push("");
  }
  lines.push(`Last Telegram delivery: ${h.lastDeliveryAt === null ? "—" : fmtTime(new Date(h.lastDeliveryAt).toISOString())}`);
  lines.push("");
  lines.push(`Telegram: CONNECTED${h.pairingUsername ? ` @${h.pairingUsername}` : ""}`);
  lines.push(`Watchdog: ${wd}`);
  lines.push(`Manual scan: AVAILABLE`);
  lines.push(
    h.resolver && typeof h.resolver.at === "number"
      ? `Resolver: ${fmtTime(new Date(h.resolver.at).toISOString())} (${h.resolver.resolved} resolved / ${h.resolver.checked} checked)`
      : `Resolver: never reported`,
  );
  return lines.join("\n");
}

/** Minimal resolved-signal shape for performance summaries (precomputed outcome + R). */
export interface PerfRow {
  category: "crypto" | "stocks" | "commodities";
  symbol: string;
  direction: "LONG" | "SHORT";
  score: number;
  outcome: string;
  realized_r: number | null;
  last_seen: string;
}

function perfR(v: number): string {
  return `${v >= 0 ? "+" : ""}${Math.round(v * 100) / 100}R`;
}

function perfBand(score: number): string {
  if (score >= 90) return "90–100";
  if (score >= 80) return "80–89";
  if (score >= 70) return "70–79";
  if (score >= 60) return "60–69";
  return "<60";
}

/** "12m" / "4h 32m" / "2d 3h" (empty/Invalid safe). */
export function fmtAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export interface PerformanceMeta {
  /** Total resolved+unresolved signals in scope (0 = nothing recorded). */
  totalSignals: number;
  /** Unresolved (OPEN or not yet processed) signals in scope. */
  openCount: number;
  /** Oldest unresolved signal timestamp (ms, null when none open). */
  oldestOpenAt: number | null;
  /** Now (ms) for age computation. */
  now: number;
}

/**
 * Compact performance summary over resolved rows. Three honest states:
 * nothing recorded → zero-signals message; signals but none completed →
 * open counts + oldest age; completed → full stats. Completed =
 * WIN/LOSS/BREAKEVEN only; OPEN/EXPIRED/UNKNOWN never enter rates.
 */
export function formatPerformance(
  rows: PerfRow[],
  category?: "crypto" | "stocks" | "commodities",
  meta?: PerformanceMeta,
): string {
  const scope = category ? rows.filter((r) => r.category === category) : rows;
  const done = scope.filter((r) => r.outcome === "WIN" || r.outcome === "LOSS" || r.outcome === "BREAKEVEN");
  const title = category
    ? `📊 SIGNAL PERFORMANCE — ${category === "crypto" ? "CRYPTO" : category === "stocks" ? "STOCKS" : "COMMODITIES"}`
    : "📊 SIGNAL PERFORMANCE";
  if (done.length === 0) {
    if (meta && meta.totalSignals === 0) {
      return [title, "", "No signals recorded yet."].join("\n");
    }
    const openLine =
      meta && meta.openCount > 0
        ? [
            "",
            `Open signals: ${meta.openCount}`,
            ...(meta.oldestOpenAt !== null
              ? [`Oldest open signal: ${fmtAge(meta.now - meta.oldestOpenAt)}`]
              : []),
          ]
        : [];
    return [title, "", "No completed signals yet.", ...openLine, "", "Performance will appear when signals resolve."].join("\n");
  }
  const wins = done.filter((r) => r.outcome === "WIN").length;
  const rs = done.map((r) => (typeof r.realized_r === "number" && Number.isFinite(r.realized_r) ? r.realized_r : 0));
  const grossPos = rs.filter((x) => x > 0).reduce((a, b) => a + b, 0);
  const grossNeg = Math.abs(rs.filter((x) => x <= 0).reduce((a, b) => a + b, 0));
  const avg = rs.reduce((a, b) => a + b, 0) / rs.length;
  const lines = [
    title,
    "",
    `Signals: ${done.length}`,
    `Win rate: ${Math.round((wins / done.length) * 1000) / 10}%`,
    `Average R: ${perfR(avg)}`,
    `Profit factor: ${grossNeg > 0 ? Math.round((grossPos / grossNeg) * 100) / 100 : grossPos > 0 ? "∞" : 0}`,
    `Expectancy: ${perfR(avg)}`,
    "",
  ];
  if (!category) {
    const catR = (c: PerfRow["category"]) =>
      done.filter((r) => r.category === c).reduce((a, r) => a + (typeof r.realized_r === "number" ? r.realized_r : 0), 0);
    lines.push(
      `Crypto: ${perfR(catR("crypto"))}`,
      `Stocks: ${perfR(catR("stocks"))}`,
      `Commodities: ${perfR(catR("commodities"))}`,
      "",
    );
  }
  const bands = ["90–100", "80–89", "70–79", "60–69", "<60"];
  const bandRows = bands
    .map((b) => ({ band: b, rs: done.filter((r) => perfBand(r.score) === b).map((r) => (typeof r.realized_r === "number" ? r.realized_r : 0)) }))
    .filter((b) => b.rs.length > 0);
  if (bandRows.length > 0) {
    const best = bandRows
      .map((b) => ({ band: b.band, avg: b.rs.reduce((a, x) => a + x, 0) / b.rs.length }))
      .sort((a, b) => b.avg - a.avg)[0];
    lines.push("Best score range:", `${best.band} → ${perfR(best.avg)}`, "");
  }
  const recent = [...done]
    .sort((a, b) => Date.parse(b.last_seen) - Date.parse(a.last_seen))
    .slice(0, 3);
  if (recent.length > 0) {
    lines.push("Recent:");
    for (const r of recent) {
      lines.push(`${r.symbol} ${r.direction} → ${perfR(typeof r.realized_r === "number" ? r.realized_r : 0)}`);
    }
  }
  if (done.length < 30) {
    lines.push("", `⚠️ Small sample (${done.length} completed) — treat as preliminary.`);
  }
  return lines.join("\n");
}

/** Split long replies on line boundaries (Telegram-safe chunks). */export function splitMessage(text: string, max = 3500): string[] {
  if (text.length <= max) return [text];
  const lines = text.split("\n");
  const chunks: string[] = [];
  let cur = "";
  for (const line of lines) {
    const next = cur === "" ? line : `${cur}\n${line}`;
    if (next.length > max && cur !== "") {
      chunks.push(cur);
      cur = line;
    } else {
      cur = next;
    }
  }
  if (cur !== "") chunks.push(cur);
  return chunks.length > 0 ? chunks : [text.slice(0, max)];
}

interface TelegramUpdate {
  message?: {
    chat?: { id?: number | string; username?: string };
    from?: { username?: string };
    text?: string;
  };
}

const SITE_URL = Deno.env.get("SITE_URL") ?? "https://sunilkjt.github.io/crypto-paper";

function ok(): Response {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

async function botSend(
  botToken: string,
  chatId: string,
  text: string,
  url: string | null = null,
): Promise<void> {
  try {
    const payload: Record<string, unknown> = { chat_id: chatId, text: text.slice(0, 3500) };
    if (url) {
      payload.reply_markup = { inline_keyboard: [[{ text: "View Analysis", url }]] };
    }
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // best effort
  }
}

function analysisUrl(symbol: string): string {
  return `${SITE_URL.replace(/\/$/, "")}/#/coin/${symbol.trim()}`;
}

/** Send + return the Bot API message_id (for ack edits), null on failure. */
async function botSendRet(botToken: string, chatId: string, text: string): Promise<number | null> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 3500) }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json().catch(() => null)) as { result?: { message_id?: unknown } } | null;
    const id = body?.result?.message_id;
    return typeof id === "number" ? id : null;
  } catch {
    return null;
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
    return ok();
  }

  let update: TelegramUpdate;
  try {
    update = (await req.json()) as TelegramUpdate;
  } catch {
    return ok();
  }

  const text = update.message?.text ?? "";
  const chatId = update.message?.chat?.id;
  if (chatId === undefined || chatId === null) return ok();
  const chat = String(chatId);
  const username = update.message?.from?.username ?? update.message?.chat?.username ?? null;

  const dbHeaders = {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
  };
  const db = async (path: string): Promise<{ status: number; json: unknown }> => {
    try {
      const res = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
        headers: dbHeaders,
        signal: AbortSignal.timeout(10_000),
      });
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        // ignore body read failures
      }
      return { status: res.status, json: body };
    } catch {
      return { status: 0, json: null };
    }
  };
  const admin = {
    async query(path: string): Promise<SignalRow[] | null> {
      const r = await db(path);
      if (r.status !== 200 || !Array.isArray(r.json)) return null;
      return r.json as SignalRow[];
    },
  };

  /** Exact row count via PostgREST content-range (null when unavailable). */
  const dbCount = async (path: string): Promise<number | null> => {
    try {
      const res = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
        headers: { ...dbHeaders, Prefer: "count=exact" },
        signal: AbortSignal.timeout(10_000),
      });
      const cr = res.headers.get("content-range") ?? "";
      const m = /\/(\d+)\s*$/.exec(cr);
      return m ? Number.parseInt(m[1], 10) : null;
    } catch {
      return null;
    }
  };

  // /stop from Telegram disables the link (chat-owned action, always safe).
  if (text === "/stop" || text.startsWith("/stop ")) {
    try {
      await fetch(
        `${supabaseUrl}/rest/v1/telegram_connections?telegram_chat_id=eq.${encodeURIComponent(chat)}`,
        {
          method: "PATCH",
          headers: { ...dbHeaders, "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: false }),
          signal: AbortSignal.timeout(10_000),
        },
      );
    } catch {
      // best effort
    }
    await botSend(botToken, chat, "CryptoIn notifications paused for this chat. Reconnect anytime from the website.");
    return ok();
  }

  // /start <token> links the chat (existing pairing flow, unchanged).
  const startMatch = /^\/start\s+([0-9a-fA-F]{16,128})\s*$/.exec(text.trim());
  if (startMatch) {
    const token = startMatch[1].toLowerCase();
    const r = await db(
      `telegram_connect_tokens?token=eq.${encodeURIComponent(token)}&select=user_id,expires_at,used_at`,
    );
    const row =
      r.status === 200 && Array.isArray(r.json) && r.json.length > 0
        ? (r.json[0] as { user_id: string; expires_at: string; used_at: string | null })
        : null;
    const valid = row !== null && row.used_at === null && Date.parse(row.expires_at) > Date.now();
    if (!valid) {
      await botSend(
        botToken,
        chat,
        "That connection link expired or was already used. Please generate a fresh one on the website (Settings → Telegram → Connect).",
      );
      return ok();
    }
    try {
      await fetch(`${supabaseUrl}/rest/v1/telegram_connections`, {
        method: "POST",
        headers: { ...dbHeaders, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" },
        body: JSON.stringify({
          user_id: row.user_id,
          telegram_chat_id: chat,
          telegram_username: username,
          enabled: true,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      await fetch(
        `${supabaseUrl}/rest/v1/telegram_connect_tokens?token=eq.${encodeURIComponent(token)}`,
        {
          method: "PATCH",
          headers: { ...dbHeaders, "Content-Type": "application/json" },
          body: JSON.stringify({ used_at: new Date().toISOString() }),
          signal: AbortSignal.timeout(10_000),
        },
      );
      await fetch(
        `${supabaseUrl}/rest/v1/telegram_connect_tokens?user_id=eq.${encodeURIComponent(row.user_id)}&token=neq.${encodeURIComponent(token)}`,
        { method: "DELETE", headers: dbHeaders, signal: AbortSignal.timeout(10_000) },
      );
    } catch {
      // best effort — the link reply below still fires only on success path
    }
    await botSend(
      botToken,
      chat,
      "✅ CryptoIn connected! Paper-signal notifications for your enabled categories will arrive here. Send /stop anytime to pause.",
    );
    return ok();
  }

  // ---- Read-only commands: pairing gate first ---------------------------
  const connRes = await db(
    `telegram_connections?telegram_chat_id=eq.${encodeURIComponent(chat)}&select=user_id,enabled,telegram_username`,
  );
  const conn =
    connRes.status === 200 && Array.isArray(connRes.json) && connRes.json.length > 0
      ? (connRes.json[0] as { user_id: string; enabled: boolean; telegram_username: string | null })
      : null;
  if (!conn) {
    await botSend(botToken, chat, UNPAIRED_MESSAGE);
    return ok();
  }
  if (!conn.enabled) {
    await botSend(
      botToken,
      chat,
      "⏸️ Notifications are paused for this chat. Reconnect from the website (Settings → Telegram) to resume.",
    );
    return ok();
  }

  // Route: explicit command, else deterministic natural-language intent.
  const trimmed = text.trim();
  let parsed = parseCommand(trimmed);
  if (parsed.cmd === "unknown" && !trimmed.startsWith("/")) {
    const routed = routeNatural(trimmed);
    if (routed) parsed = parseCommand(routed);
  }

  const reply = async (body: string, url: string | null = null): Promise<void> => {
    for (const chunk of splitMessage(body)) {
      await botSend(botToken, chat, chunk, url);
    }
  };

  try {
    switch (parsed.cmd) {
      case "help": {
        await reply(formatHelp());
        return ok();
      }
      case "status": {
        const st = await db(`scanner_state?key=eq.cron-monitor&select=value`);
        let lastRunAt: number | null = null;
        let perCategory: Record<string, { universe: number; scanned: number; signals: number }> = {};
        let lastDeliveryAt: number | null = null;
        if (st.status === 200 && Array.isArray(st.json) && st.json.length > 0) {
          const v = (st.json[0] as { value?: unknown }).value as {
            lastRun?: {
              at?: unknown;
              perCategory?: unknown;
              lastDeliveryAt?: unknown;
            };
          } | undefined;
          if (v && typeof v.lastRun === "object" && v.lastRun !== null) {
            const lr = v.lastRun as {
              at?: unknown;
              perCategory?: Record<string, { universe?: unknown; scanned?: unknown; signals?: unknown }>;
              lastDeliveryAt?: unknown;
            };
            lastRunAt = typeof lr.at === "number" ? lr.at : null;
            lastDeliveryAt = typeof lr.lastDeliveryAt === "number" ? lr.lastDeliveryAt : null;
            for (const [k, c] of Object.entries(lr.perCategory ?? {})) {
              perCategory[k] = {
                universe: typeof c.universe === "number" ? c.universe : 0,
                scanned: typeof c.scanned === "number" ? c.scanned : 0,
                signals: typeof c.signals === "number" ? c.signals : 0,
              };
            }
          }
        }
        // Latest servable signal + today's counts (bounded reads, indexed).
        let lastSignalAt: string | null = null;
        const todayCounts = { crypto: 0, stocks: 0, commodities: 0 };
        const latest = await admin.query(`signal_history?select=last_seen,category&order=last_seen.desc&limit=1`);
        if (latest && latest.length > 0 && typeof latest[0].last_seen === "string") {
          lastSignalAt = latest[0].last_seen;
        }
        const midnight = new Date();
        midnight.setUTCHours(0, 0, 0, 0);
        const today = await admin.query(
          `signal_history?last_seen=gte.${encodeURIComponent(midnight.toISOString())}&select=category&limit=500`,
        );
        if (today) {
          for (const r of today) {
            if (r.category === "crypto") todayCounts.crypto += 1;
            else if (r.category === "stocks") todayCounts.stocks += 1;
            else if (r.category === "commodities") todayCounts.commodities += 1;
          }
        }
        // Watchdog arming state (null row = unknown, never an error).
        let watchdogAlerting: boolean | null = null;
        const wd = await db(`scanner_state?key=eq.watchdog&select=value`);
        if (wd.status === 200 && Array.isArray(wd.json) && wd.json.length > 0) {
          const wv = (wd.json[0] as { value?: unknown }).value as { alertedAt?: unknown } | undefined;
          if (wv && typeof wv === "object") {
            watchdogAlerting = typeof wv.alertedAt === "number" ? true : false;
          }
        }
        // Outcome-resolver heartbeat (null row = never reported, never an error).
        let resolver: { at: number; checked: number; resolved: number } | null = null;
        const rs = await db(`scanner_state?key=eq.resolve-outcomes&select=value`);
        if (rs.status === 200 && Array.isArray(rs.json) && rs.json.length > 0) {
          const rv = (rs.json[0] as { value?: unknown }).value as {
            at?: unknown;
            checked?: unknown;
            resolved?: unknown;
          } | undefined;
          if (rv && typeof rv.at === "number") {
            resolver = {
              at: rv.at,
              checked: typeof rv.checked === "number" ? rv.checked : 0,
              resolved: typeof rv.resolved === "number" ? rv.resolved : 0,
            };
          }
        }
        await reply(
          formatStatus({
            lastRunAt,
            perCategory,
            lastDeliveryAt,
            now: Date.now(),
            pairingUsername: conn.telegram_username,
            lastSignalAt,
            todayCounts,
            watchdogAlerting,
            resolver,
          }),
        );
        return ok();
      }
      case "signals": {
        const cat = parsed.category;
        const q = cat
          ? `signal_history?category=eq.${cat}&select=*&order=last_seen.desc&limit=5`
          : `signal_history?select=*&order=last_seen.desc&limit=5`;
        const rows = await admin.query(q);
        if (rows === null) {
          await reply(DB_ERROR_MESSAGE);
          return ok();
        }
        await reply(formatSignalsList(rows));
        return ok();
      }
      case "today": {
        const midnight = new Date();
        midnight.setUTCHours(0, 0, 0, 0);
        const rows = await admin.query(
          `signal_history?last_seen=gte.${encodeURIComponent(midnight.toISOString())}&select=*&order=last_seen.desc&limit=200`,
        );
        if (rows === null) {
          await reply(DB_ERROR_MESSAGE);
          return ok();
        }
        await reply(formatToday(rows));
        return ok();
      }
      case "last": {
        if (!parsed.symbol) {
          const rows = await admin.query(`signal_history?select=*&order=last_seen.desc&limit=1`);
          if (rows === null) {
            await reply(DB_ERROR_MESSAGE);
            return ok();
          }
          if (rows.length === 0) {
            await reply(EMPTY_MESSAGE);
            return ok();
          }
          await reply(formatSignalDetail(rows[0]), analysisUrl(rows[0].symbol));
          return ok();
        }
        const filter = symbolFilter(parsed.symbol);
        if (!filter) {
          await reply(EMPTY_MESSAGE);
          return ok();
        }
        const rows = await admin.query(`signal_history?${filter}&select=*&order=last_seen.desc&limit=1`);
        if (rows === null) {
          await reply(DB_ERROR_MESSAGE);
          return ok();
        }
        if (rows.length === 0) {
          await reply(`No qualifying signals found for ${parsed.symbol}.`);
          return ok();
        }
        await reply(formatSignalDetail(rows[0]), analysisUrl(rows[0].symbol));
        return ok();
      }
      case "history": {
        const rows = await admin.query(
          `signal_history?select=*&order=last_seen.desc&limit=${parsed.limit}`,
        );
        if (rows === null) {
          await reply(DB_ERROR_MESSAGE);
          return ok();
        }
        if (rows.length === 0) {
          await reply(EMPTY_MESSAGE);
          return ok();
        }
        const lines = ["📚 SIGNAL HISTORY", ""];
        rows.forEach((r, i) => lines.push(formatSignalLine(r, i + 1), ""));
        await reply(lines.join("\n").trimEnd());
        return ok();
      }
      case "scan": {
        // Manual on-demand scan: acknowledge immediately, then hand off to
        // the telegram-scan function (same deterministic engine, read-only:
        // no history writes, no cooldown gate). The 200 returns fast so
        // Telegram never retries into duplicate scans.
        const ackId = await botSendRet(botToken, chat, SCAN_ACK_MESSAGE);
        const invokeScan = async (): Promise<void> => {
          try {
            await fetch(`${supabaseUrl}/functions/v1/telegram-scan`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                apikey: serviceKey,
                Authorization: `Bearer ${serviceKey}`,
              },
              body: JSON.stringify({ chat_id: chat, args: parsed.args, ack_message_id: ackId }),
              signal: AbortSignal.timeout(20_000),
            });
          } catch {
            // Invocation failed (scan function missing/not deployed yet):
            // leave the ack in place and explain instead of going silent.
            try {
              await botSend(
                botToken,
                chat,
                "⚠️ Manual scan is not available yet (scan service unreachable). The scheduled 24/7 scanner is unaffected — try /signals.",
              );
            } catch {
              // best effort
            }
          }
        };
        const runtime = (
          globalThis as unknown as { EdgeRuntime?: { waitUntil: (p: Promise<unknown>) => void } }
        ).EdgeRuntime;
        if (runtime && typeof runtime.waitUntil === "function") {
          runtime.waitUntil(invokeScan());
        } else {
          await invokeScan();
        }
        return ok();
      }
      case "performance": {
        const cat = parsed.category ? `category=eq.${parsed.category}&` : "";
        const prows = await admin.query(
          `signal_history?${cat}select=category,symbol,direction,score,outcome,realized_r,last_seen&order=last_seen.desc&limit=500`,
        );
        if (prows === null) {
          await reply(DB_ERROR_MESSAGE);
          return ok();
        }
        const perf = (prows as unknown as Record<string, unknown>[])
          .filter(
            (r) =>
              (r.category === "crypto" || r.category === "stocks" || r.category === "commodities") &&
              (r.direction === "LONG" || r.direction === "SHORT") &&
              typeof r.symbol === "string" &&
              typeof r.score === "number" &&
              typeof r.outcome === "string" &&
              typeof r.last_seen === "string",
          )
          .map((r) => ({
            category: r.category as "crypto" | "stocks" | "commodities",
            symbol: r.symbol as string,
            direction: r.direction as "LONG" | "SHORT",
            score: r.score as number,
            outcome: r.outcome as string,
            realized_r: typeof r.realized_r === "number" ? (r.realized_r as number) : null,
            last_seen: r.last_seen as string,
          }));
        // Scope totals come from exact counts (not the 500-row sample).
        const total = await dbCount(`signal_history?${cat}select=id`);
        const open = await dbCount(`signal_history?${cat}outcome=is.null&select=id`);
        let oldestOpenAt: number | null = null;
        const oldest = await db(
          `signal_history?${cat}outcome=is.null&select=first_seen&order=first_seen.asc&limit=1`,
        );
        if (oldest.status === 200 && Array.isArray(oldest.json) && oldest.json.length > 0) {
          const t = Date.parse(String((oldest.json[0] as { first_seen?: unknown }).first_seen ?? ""));
          if (Number.isFinite(t)) oldestOpenAt = t;
        }
        await reply(
          formatPerformance(
            perf,
            parsed.category,
            total !== null
              ? { totalSignals: total, openCount: open ?? 0, oldestOpenAt, now: Date.now() }
              : undefined,
          ),
        );
        return ok();
      }
      default: {
        await reply("I didn't understand that. Send /help for commands I know.");
        return ok();
      }
    }
  } catch {
    await reply(DB_ERROR_MESSAGE);
    return ok();
  }
});
