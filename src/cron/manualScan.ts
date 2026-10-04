import { classifyMarket, type MarketCategory } from "../market/classify";
import type { Market } from "../market/hyperliquid/types";
import { rankSetups, type ScannedCoin, type ScanSummary } from "../scanner/engine";
import { mainDexSymbols } from "./universe";

/**
 * Manual on-demand market scan for Telegram `/scan`.
 *
 * Reuses the EXACT deterministic pipeline as the 24/7 cron (same market
 * discovery, same candle fetcher, same signal engine, same scoring) but
 * with a strictly read-only contract:
 *
 * - NO cron state reads/writes (scheduled scanner untouched)
 * - NO signal_history writes (never fabricates scheduled-signal rows)
 * - NO notification cooldown/fingerprint gate (user explicitly asked)
 * - NO AI (engine decides everything, as always)
 *
 * Production wiring (edge function) injects getMarkets + runFullScan;
 * tests inject fakes. Per-market failures are isolated inside runFullScan;
 * per-category failures are isolated here — one bad category never aborts
 * the others.
 */

export type ScanDirection = "LONG" | "SHORT" | "ALL";

export interface ScanRequest {
  categories: MarketCategory[];
  direction: ScanDirection;
  tradeOnly: boolean;
  limit: number;
}

export const DEFAULT_SCAN_LIMIT = 10;
export const MAX_SCAN_LIMIT = 20;

/**
 * Minimum score for `/scan trade`. Mirrors the cron's default notify bar
 * (NOTIFY_MIN_STRENGTH=70) so "qualified trade" means the same thing in
 * both paths — without touching the engine's own LONG/SHORT/WAIT verdict.
 */
export const MANUAL_TRADE_MIN_STRENGTH = 70;

/** Strong non-directional setups shown in the WATCH section (never trades). */
export const WATCH_MIN_STRENGTH = 60;
const MAX_WATCH = 3;

export const SCAN_ACK_MESSAGE =
  "🔎 Scanning Hyperliquid markets...\n\nCrypto + Stocks + Commodities\nPlease wait...";
export const SCAN_BUSY_MESSAGE =
  "🔎 A manual scan is already running for this chat. Please wait for it to finish, then try again.";
export const SCAN_FAILED_MESSAGE =
  "⚠️ MARKET SCAN FAILED\n\nUnable to retrieve fresh market data right now.\n\nPlease try again shortly.";
export const SCAN_UNAUTHORIZED_MESSAGE =
  "🔒 Telegram is not connected to a CryptoIn account.\n\nOpen CryptoIn and connect Telegram first.";

/** Case-insensitive, order-independent: category + direction + trade + limit. */
export function parseScanArgs(raw: string): ScanRequest {
  const tokens = raw.trim().toLowerCase().split(/\s+/).filter(Boolean);
  let category: MarketCategory | null = null;
  let direction: ScanDirection = "ALL";
  let tradeOnly = false;
  let limit = DEFAULT_SCAN_LIMIT;
  for (const t of tokens) {
    if (t === "crypto" || t === "stocks" || t === "commodities") {
      category = t;
    } else if (t === "long") {
      direction = "LONG";
    } else if (t === "short") {
      direction = "SHORT";
    } else if (t === "trade" || t === "trades") {
      tradeOnly = true;
    } else if (/^\d+$/.test(t)) {
      const n = Number.parseInt(t, 10);
      if (Number.isFinite(n)) limit = Math.min(MAX_SCAN_LIMIT, Math.max(1, n));
    }
    // Unknown tokens are ignored (never an error, never a guess).
  }
  return {
    categories: category ? [category] : ["crypto", "stocks", "commodities"],
    direction,
    tradeOnly,
    limit,
  };
}

export interface ManualScanDeps {
  now: number;
  /** Fresh market discovery (production: getMarkets with bypassCache). */
  listMarkets: () => Promise<{ markets: Market[]; updatedAt: number }>;
  /**
   * Deterministic per-category scan (production: runFullScan with the same
   * eligibility + concurrency as the cron). Must isolate per-market
   * failures internally and report them via summary.excluded.
   */
  scanCategory: (universe: Market[], category: MarketCategory) => Promise<ScanSummary>;
  signal?: AbortSignal;
  log?: (msg: string) => void;
}

export interface CategoryScanCounts {
  category: MarketCategory;
  universe: number;
  scanned: number;
  skipped: number;
  longs: number;
  shorts: number;
}

export interface ManualScanResult {
  request: ScanRequest;
  generatedAt: number;
  marketsDiscovered: number;
  perCategory: CategoryScanCounts[];
  /** Ranked directional candidates (tradeOnly already applied). */
  candidates: ScannedCoin[];
  /** Pre-limit pool size behind `candidates` (for "top X of Y"). */
  poolSize: number;
  /** Strong WAIT setups for the WATCH section (never trades, never in trade mode). */
  watch: ScannedCoin[];
  totalLongs: number;
  totalShorts: number;
  failures: string[];
  /** True when some category failed but others produced real results. */
  partial: boolean;
}

export class ManualScanError extends Error {
  readonly code: "markets-unavailable";
  constructor(message: string) {
    super(message);
    this.code = "markets-unavailable";
  }
}

/**
 * Run a fresh manual scan. Read-only: returns ranked engine output.
 * Throws ManualScanError only when NO fresh market data exists at all
 * (callers must show SCAN_FAILED_MESSAGE — never stale data as fresh).
 */
export async function runManualMarketScan(
  deps: ManualScanDeps,
  req: ScanRequest,
): Promise<ManualScanResult> {
  const log = deps.log ?? (() => {});
  let markets: Market[];
  try {
    const discovered = await deps.listMarkets();
    markets = discovered.markets;
  } catch (err) {
    throw new ManualScanError(err instanceof Error && err.message ? err.message : "Market discovery failed.");
  }
  if (markets.length === 0) {
    throw new ManualScanError("Market discovery returned no markets.");
  }
  const main = mainDexSymbols(markets);
  const failures: string[] = [];
  const perCategory: CategoryScanCounts[] = [];
  const all: ScannedCoin[] = [];
  let aborted = false;

  for (const category of req.categories) {
    if (deps.signal?.aborted) {
      aborted = true;
      break;
    }
    const universe = markets.filter((m) => classifyMarket(m.symbol, main) === category);
    const counts: CategoryScanCounts = {
      category,
      universe: universe.length,
      scanned: 0,
      skipped: 0,
      longs: 0,
      shorts: 0,
    };
    if (universe.length === 0) {
      log(`manual-scan: ${category}: no markets listed, skipped`);
      perCategory.push(counts);
      continue;
    }
    try {
      const summary = await deps.scanCategory(universe, category);
      counts.scanned = summary.scanned;
      counts.skipped = summary.excluded.length;
      for (const r of summary.results) {
        if (r.signal.direction === "LONG") counts.longs += 1;
        else if (r.signal.direction === "SHORT") counts.shorts += 1;
      }
      all.push(...summary.results);
      log(
        `manual-scan: ${category}: universe=${counts.universe} scanned=${counts.scanned} ` +
          `skipped=${counts.skipped} longs=${counts.longs} shorts=${counts.shorts}`,
      );
    } catch (err) {
      const msg = err instanceof Error && err.message ? err.message : "unknown scan error";
      failures.push(`${category}: ${msg}`);
      log(`manual-scan: ${category}: ERROR ${msg}`);
    }
    perCategory.push(counts);
  }

  if (all.length === 0) {
    throw new ManualScanError(
      failures.length > 0 ? failures.join("; ") : "No markets could be scanned.",
    );
  }

  let pool = all;
  if (req.direction !== "ALL") pool = pool.filter((r) => r.signal.direction === req.direction);
  if (req.tradeOnly) {
    pool = pool.filter(
      (r) => r.signal.direction !== "WAIT" && r.signal.signalStrength >= MANUAL_TRADE_MIN_STRENGTH,
    );
  }
  const candidates = rankSetups(pool).slice(0, req.limit);  const watch =
    !req.tradeOnly && req.direction === "ALL"
      ? [...all]
          .filter((r) => r.signal.direction === "WAIT" && r.signal.signalStrength >= WATCH_MIN_STRENGTH)
          .sort((a, b) => b.signal.signalStrength - a.signal.signalStrength)
          .slice(0, MAX_WATCH)
      : [];

  return {
    request: req,
    generatedAt: deps.now,
    marketsDiscovered: markets.length,
    perCategory,
    candidates,
    poolSize: pool.length,
    watch,
    totalLongs: all.filter((r) => r.signal.direction === "LONG").length,
    totalShorts: all.filter((r) => r.signal.direction === "SHORT").length,
    failures: aborted ? [...failures, "scan deadline reached — showing completed categories"] : failures,
    partial: failures.length > 0 || aborted,
  };
}

/** Pairing gate for the scan endpoint (DB lookup injected; no secrets here). */
export async function verifyScanAccess(
  lookup: (chatId: string) => Promise<{ paired: boolean; enabled: boolean }>,
  chatId: string,
): Promise<{ ok: boolean; reason: "unpaired" | "paused" | null }> {
  const conn = await lookup(chatId);
  if (!conn.paired) return { ok: false, reason: "unpaired" };
  if (!conn.enabled) return { ok: false, reason: "paused" };
  return { ok: true, reason: null };
}

// ---- Formatting (engine fields only, DEX namespace preserved) ----

function fmtMoney(v: number | null): string {
  if (typeof v !== "number" || !Number.isFinite(v)) return "—";
  return `$${v.toLocaleString("en-US", { maximumFractionDigits: v >= 100 ? 2 : 4 })}`;
}

function fmtTimeUTC(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  return `${new Date(ms).toISOString().slice(11, 16)} UTC`;
}

function catTitle(c: MarketCategory): string {
  return c === "crypto" ? "CRYPTO" : c === "stocks" ? "STOCKS" : "COMMODITIES";
}

function formatCandidate(r: ScannedCoin): string[] {
  const s = r.signal;
  const emoji = s.direction === "LONG" ? "🟢" : "🔴";
  const entry =
    s.entryLow !== null && s.entryHigh !== null
      ? `${fmtMoney(s.entryLow)} – ${fmtMoney(s.entryHigh)}`
      : fmtMoney(s.entryLow);
  const reasons = s.reasons.length > 0 ? s.reasons.slice(0, 4) : ["(engine gave no detailed reasons)"];
  return [
    `${emoji} ${s.direction} — ${r.symbol}`,
    `Score: ${s.signalStrength}/100`,
    `Entry: ${entry}`,
    `SL: ${fmtMoney(s.invalidation)}`,
    `TP1: ${fmtMoney(s.tp1)}`,
    `TP2: ${fmtMoney(s.tp2)}`,
    `R:R: ${s.riskReward !== null ? s.riskReward : "—"}`,
    "",
    "Reasons:",
    ...reasons.map((x) => `• ${x}`),
  ];
}

/** Compact Telegram reply for a completed manual scan. */
export function formatManualScanResult(res: ManualScanResult): string {
  const { request } = res;
  const scanned = res.perCategory.reduce((a, c) => a + c.scanned, 0);
  const skipped = res.perCategory.reduce((a, c) => a + c.skipped, 0);
  const catName = request.categories.length === 3 ? "ALL" : catTitle(request.categories[0]);
  const lines = [
    "🔎 MARKET SCAN",
    "━━━━━━━━━━━━━━",
    "",
    `Scanned: ${scanned} markets`,
    ...(skipped > 0 ? [`Skipped: ${skipped}`] : []),
    `Category: ${catName}`,
    "Timeframe: 15M",
    `Generated: ${fmtTimeUTC(res.generatedAt)}`,
    ...(res.partial ? ["", `⚠️ Partial scan: ${res.failures.join("; ")}`] : []),
  ];

  if (res.candidates.length === 0) {
    lines.push(
      "",
      request.tradeOnly ? "No qualified trade setups right now." : "No candidates match these filters right now.",
      "",
      `Markets scanned: ${res.marketsDiscovered}`,
      `LONG candidates: ${res.totalLongs}`,
      `SHORT candidates: ${res.totalShorts}`,
      "",
      request.tradeOnly
        ? "The market conditions currently do not meet the configured signal threshold."
        : "Try widening the filters (e.g. /scan without direction).",
    );
    return lines.join("\n");
  }

  for (const r of res.candidates) {
    lines.push("", "━━━━━━━━━━━━━━", "", ...formatCandidate(r));
  }

  if (res.watch.length > 0) {
    lines.push("", "━━━━━━━━━━━━━━", "", "⏳ WATCH", "");
    for (const w of res.watch) {
      lines.push(`${w.symbol} — ${w.signal.signalStrength}/100`);
      lines.push(`${w.setupType} · ${w.signal.classification}`);
      lines.push("");
    }
  }

  lines.push("━━━━━━━━━━━━━━", "");
  lines.push(`Showing top ${res.candidates.length} of ${Math.max(res.poolSize, res.candidates.length)} candidates.`);
  return lines.join("\n").trimEnd();
}
