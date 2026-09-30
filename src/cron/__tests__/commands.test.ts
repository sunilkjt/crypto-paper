import { describe, expect, it } from "vitest";
// Shared with the Deno webhook (relative import works in both runtimes).
import {
  catLabel,
  clampHistoryLimit,
  DB_ERROR_MESSAGE,
  dirArrow,
  EMPTY_MESSAGE,
  fmtDateTime,
  fmtTime,
  formatHelp,
  formatSignalDetail,
  formatSignalLine,
  formatSignalsList,
  formatStatus,
  formatToday,
  parseCommand,
  routeNatural,
  splitMessage,
  symbolFilter,
  UNPAIRED_MESSAGE,
  type SignalRow,
} from "../../../supabase/functions/_shared/commands";

function row(over: Partial<SignalRow> = {}): SignalRow {
  return {
    id: "xyz:AAPL|LONG|15m|TREND|1",
    category: "stocks",
    symbol: "xyz:AAPL",
    direction: "LONG",
    score: 84,
    timeframe: "15m",
    entry_low: 182.2,
    entry_high: 182.4,
    invalidation: 179.8,
    tp1: 187,
    tp2: 189.5,
    tp3: 192,
    risk_reward: 2,
    setup_type: "TREND",
    status: "NEW",
    first_seen: "2026-09-30T17:00:00.000Z",
    last_seen: "2026-09-30T18:05:00.000Z",
    ...over,
  };
}

describe("command parsing", () => {
  it("parses slash commands with args, @suffix and sloppy spacing", () => {
    expect(parseCommand("/help")).toEqual({ cmd: "help" });
    expect(parseCommand("/signals stocks")).toEqual({ cmd: "signals", category: "stocks" });
    expect(parseCommand("/signals@mybot crypto")).toEqual({ cmd: "signals", category: "crypto" });
    expect(parseCommand("  /last   BTC  ")).toEqual({ cmd: "last", symbol: "BTC" });
    expect(parseCommand("/last")).toEqual({ cmd: "last", symbol: undefined });
    expect(parseCommand("/history 20")).toEqual({ cmd: "history", limit: 20 });
    expect(parseCommand("/status")).toEqual({ cmd: "status" });
    expect(parseCommand("/stop")).toEqual({ cmd: "stop" });
    expect(parseCommand("/unknown-thing")).toEqual({ cmd: "unknown" });
    expect(parseCommand("")).toEqual({ cmd: "unknown" });
  });

  it("clamps history depth 1..50, default 10", () => {
    expect(parseCommand("/history")).toEqual({ cmd: "history", limit: 10 });
    expect(parseCommand("/history 500")).toEqual({ cmd: "history", limit: 50 });
    expect(parseCommand("/history 0")).toEqual({ cmd: "history", limit: 1 });
    expect(parseCommand("/history abc")).toEqual({ cmd: "history", limit: 10 });
    expect(clampHistoryLimit(Number.NaN)).toBe(10);
  });

  it("routes natural language deterministically (never Groq)", () => {
    expect(routeNatural("scanner status")).toBe("/status");
    expect(routeNatural("Is the scanner running?")).toBe("/status");
    expect(routeNatural("show today's signals")).toBe("/today");
    expect(routeNatural("show today's stock signals")).toBe("/signals stocks");
    expect(routeNatural("what was the last BTC signal")).toBe("/last BTC");
    expect(routeNatural("what was the last stock signal")).toBe("/signals stocks");
    expect(routeNatural("show commodity signals")).toBe("/signals commodities");
    expect(routeNatural("show previous signals")).toBe("/signals");
    expect(routeNatural("show signal history")).toBe("/signals");
    expect(routeNatural("blah blah nonsense")).toBeNull();
    expect(routeNatural("")).toBeNull();
  });

  it("builds collision-safe symbol filters", () => {
    expect(symbolFilter("BTC")).toBe("or=(symbol.eq.BTC,symbol.like.*:BTC)");
    expect(symbolFilter("xyz:AAPL")).toBe("symbol.eq.XYZ:AAPL");
    expect(symbolFilter("")).toBeNull();
    expect(symbolFilter("!!!")).toBeNull();
  });
});

describe("formatters", () => {
  it("labels categories with arrows, never color-only", () => {
    expect(catLabel("stocks")).toBe("STOCK");
    expect(catLabel("commodities")).toBe("COMMODITY");
    expect(catLabel("crypto")).toBe("CRYPTO");
    expect(dirArrow("LONG")).toBe("📈");
    expect(dirArrow("SHORT")).toBe("📉");
  });

  it("formats UTC times safely", () => {
    expect(fmtTime("2026-09-30T18:05:00.000Z")).toBe("18:05 UTC");
    expect(fmtDateTime("2026-09-30T18:05:00.000Z")).toBe("2026-09-30 18:05 UTC");
    expect(fmtTime("garbage")).toBe("—");
  });

  it("renders a full signal detail block", () => {
    const d = formatSignalDetail(row());
    for (const needle of ["STOCK", "LONG", "xyz:AAPL", "84", "$182.2", "$179.8", "$187", "1 : 2", "15m", "18:05 UTC"]) {
      expect(d).toContain(needle);
    }
  });

  it("renders empty states, never errors-as-data", () => {
    expect(formatSignalsList([])).toBe(EMPTY_MESSAGE);
    expect(formatToday([])).toBe(EMPTY_MESSAGE);
    expect(DB_ERROR_MESSAGE).toContain("try again");
    expect(UNPAIRED_MESSAGE).toContain("connect Telegram");
  });

  it("today aggregates counts then lists at most 10", () => {
    const rows = [
      row(),
      row({ id: "2", symbol: "BTC", category: "crypto", direction: "SHORT", score: 81 }),
      row({ id: "3", symbol: "xyz:GOLD", category: "commodities", direction: "SHORT", score: 79 }),
    ];
    const t = formatToday(rows);
    expect(t).toContain("Crypto");
    expect(t).toContain("1 LONG");
    expect(t).toContain("Commodities");
    const many = Array.from({ length: 12 }, (_, i) => row({ id: String(i) }));
    expect(formatToday(many)).toContain("Showing latest 10 signals.");
  });

  it("history lines are compact and ordered by caller", () => {
    expect(formatSignalLine(row(), 1)).toContain("1. 📈 STOCK LONG — xyz:AAPL");
  });

  it("status is ONLINE only from a fresh heartbeat", () => {
    const online = formatStatus({
      lastRunAt: 1_000_000,
      perCategory: { crypto: { universe: 142, scanned: 40, signals: 6 } },
      lastDeliveryAt: 999_000,
      now: 1_000_000 + 60_000,
    });
    expect(online).toContain("ONLINE");
    expect(online).toContain("142 markets");
    const stale = formatStatus({ lastRunAt: 1_000_000, perCategory: {}, lastDeliveryAt: null, now: 1_000_000 + 20 * 60_000 });
    expect(stale).toContain("delayed");
    const never = formatStatus({ lastRunAt: null, perCategory: {}, lastDeliveryAt: null, now: 2_000_000 });
    expect(never).toContain("delayed");
    expect(never).not.toContain("ONLINE");
  });

  it("help lists every command concisely", () => {
    const h = formatHelp();
    for (const needle of ["/status", "/signals", "/today", "/last", "/history", "/help"]) {
      expect(h).toContain(needle);
    }
  });

  it("splits oversized messages on line boundaries", () => {
    const big = Array.from({ length: 200 }, (_, i) => `line-${i}-` + "x".repeat(50)).join("\n");
    const chunks = splitMessage(big, 1000);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length <= 1100)).toBe(true);
    expect(chunks.join("\n")).toBe(big);
  });
});
