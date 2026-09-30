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
  | { cmd: "unknown" };

export const UNPAIRED_MESSAGE =
  "🔒 Telegram is not connected to a CryptoIn account.\n\nOpen CryptoIn and connect Telegram first.";
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
  return typeof v === "number" && Number.isFinite(v) ? `$${v}` : "—";
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
}

/** ONLINE only from a fresh heartbeat — never from mere DB existence. */
export function formatStatus(h: Heartbeat): string {
  const STALE_AFTER_MS = 15 * 60_000;
  const online = h.lastRunAt !== null && h.now - h.lastRunAt <= STALE_AFTER_MS;
  const lines = [
    `${online ? "🟢" : "🟠"} CryptoIn Scanner`,
    "",
    `Status: ${online ? "ONLINE" : "Scanner may be delayed"}`,
    "",
    `Last scan: ${h.lastRunAt === null ? "—" : fmtTime(new Date(h.lastRunAt).toISOString())}`,
    "",
  ];
  for (const cat of ["crypto", "stocks", "commodities"] as const) {
    const c = h.perCategory[cat];
    const label = cat === "crypto" ? "Crypto" : cat === "stocks" ? "Stocks" : "Commodities";
    lines.push(`${label}: ${c ? `${c.universe} markets` : "—"}`);
    lines.push("");
  }
  lines.push(`Last Telegram delivery: ${h.lastDeliveryAt === null ? "—" : fmtTime(new Date(h.lastDeliveryAt).toISOString())}`);
  lines.push("");
  lines.push("Telegram: Connected");
  return lines.join("\n");
}

/** Split long replies on line boundaries (Telegram-safe chunks). */
export function splitMessage(text: string, max = 3500): string[] {
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
