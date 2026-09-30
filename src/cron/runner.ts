import { evaluateScan, evaluateTargets, type MonitorSnapshot } from "../alerts/monitor";
import { fingerprintOf, isOutsideCooldown } from "../alerts/cooldown";
import { resolveEventCategory, type SignalEvent } from "../alerts/events";
import type { AlertSettings } from "../alerts/settings";
import { nextLifecycleState, type SignalLifecycleState } from "../signals";
import { DEFAULT_MAX_SIGNAL_AGE_MS, isExpired } from "../alerts/expiry";
import type { MarketCategory } from "../market/classify";
import type { Market } from "../market/hyperliquid/types";
import type { ScanSummary } from "../scanner/engine";
import { buildUniverse, mainDexSymbols } from "./universe";
import type { CronState, SeenEntry } from "./state";

/**
 * Headless scheduled run: markets → per-category deterministic scans →
 * lifecycle transitions vs persisted state → cooldown-gated Telegram
 * delivery → state save. No browser, no journal writes, no paper trades,
 * no AI calls, no provider fan-out. Notifications only.
 */

export interface CronSettings {
  categories: MarketCategory[];
  minStrength: 60 | 70 | 80 | 90;
  directions: ("LONG" | "SHORT")[];
  cooldownMs: number;
  universeCap: number;
  concurrency: number;
}

export interface RunnerDeps {
  now: number;
  markets: Market[];
  scanCategory: (universe: Market[], category: MarketCategory) => Promise<ScanSummary>;
  loadState: () => Promise<CronState>;
  saveState: (state: CronState) => Promise<void>;
  listChats: () => Promise<string[]>;
  deliver: (events: SignalEvent[], chats: string[]) => Promise<{ delivered: number }>;
  log?: (msg: string) => void;
}

export interface CategoryReport {
  category: MarketCategory;
  universe: number;
  scanned: number;
  signals: number;
  events: number;
  deliverable: number;
  delivered: number;
  errors: string[];
}

export interface RunReport {
  categories: CategoryReport[];
  totalDelivered: number;
}

export function alertSettingsForCron(s: Pick<CronSettings, "minStrength" | "directions" | "cooldownMs"> & {
  categories: Record<MarketCategory, boolean>;
}): AlertSettings {
  return {
    minStrength: s.minStrength,
    directions: s.directions,
    setups: ["ALL"],
    timeframes: ["5m", "15m", "1h", "4h"],
    browserNotifications: false,
    soundAlerts: false,
    watchlistOnly: false,
    inAppNotifications: false,
    telegramNotifications: true,
    categories: s.categories,
    cooldownMs: 1_800_000,
  };
}

export async function runOnce(settings: CronSettings, deps: RunnerDeps): Promise<RunReport> {
  const log = deps.log ?? (() => {});
  const now = deps.now;
  const main = mainDexSymbols(deps.markets);
  const state = await deps.loadState();
  const chats = await deps.listChats().catch((e: unknown) => {
    log(`chat list failed: ${e instanceof Error ? e.message : "unknown"}`);
    return [] as string[];
  });

  const categoriesOn: Record<MarketCategory, boolean> = {
    crypto: settings.categories.includes("crypto"),
    stocks: settings.categories.includes("stocks"),
    commodities: settings.categories.includes("commodities"),
  };
  const alertSettings = alertSettingsForCron({
    minStrength: settings.minStrength,
    directions: settings.directions,
    categories: categoriesOn,
    cooldownMs: settings.cooldownMs,
  });

  const report: RunReport = { categories: [], totalDelivered: 0 };

  for (const category of settings.categories) {
    const rep: CategoryReport = {
      category,
      universe: 0,
      scanned: 0,
      signals: 0,
      events: 0,
      deliverable: 0,
      delivered: 0,
      errors: [],
    };
    try {
      const universe = buildUniverse(deps.markets, category);
      rep.universe = universe.length;
      if (universe.length === 0) {
        log(`${category}: no markets listed, skipped`);
        report.categories.push(rep);
        continue;
      }
      const summary = await deps.scanCategory(universe, category);
      rep.scanned = summary.scanned;
      rep.signals = summary.results.filter((r) => r.signal.direction !== "WAIT").length;

      const marks = new Map(universe.map((m) => [m.symbol, m.markPrice]));
      const ctx = { marks, watchlist: [] as string[], settings: alertSettings, now, mainDexSymbols: main };
      const prev = state.seens[category] ?? {};
      const prevSnap = new Map<string, MonitorSnapshot>(
        Object.entries(prev).map(([id, e]) => [id, { strength: e.strength, status: e.status }]),
      );

      const seen: Record<string, SeenEntry> = {};
      const lifecycleById = new Map<string, string>();
      for (const r of summary.results) {
        if (!r.id || r.signal.direction === "WAIT") continue;
        const p = prev[r.id];
        const price = marks.get(r.symbol) ?? null;
        const status = nextLifecycleState({
          previous: (p?.status ?? null) as SignalLifecycleState | null,
          previousStrength: p?.strength ?? null,
          strength: r.signal.signalStrength,
          price,
          invalidation: r.signal.invalidation,
          tp3: r.signal.tp3,
          direction: r.signal.direction,
        });
        const firstSeen = p?.firstSeen ?? now;
        const expired = isExpired({
          firstSeen,
          strength: r.signal.signalStrength,
          now,
          maxAgeMs: DEFAULT_MAX_SIGNAL_AGE_MS,
        });
        const finalStatus = expired ? "EXPIRED" : status;
        lifecycleById.set(r.id, finalStatus);
        seen[r.id] = { strength: r.signal.signalStrength, status: finalStatus, firstSeen };
      }

      const events = [
        ...evaluateScan(prevSnap, summary.results, lifecycleById, ctx),
        ...evaluateTargets(summary.results, marks, ctx),
      ];
      rep.events = events.length;

      const deliverable = events.filter((e) => {
        const fp = fingerprintOf({
          type: e.type,
          category: resolveEventCategory(e),
          symbol: e.symbol,
          direction: e.direction,
          timeframe: e.timeframe,
          entryLow: e.signal.entryLow,
          entryHigh: e.signal.entryHigh,
          strength: e.currentStrength,
        });
        if (!isOutsideCooldown(state.cooldowns[fp], now, settings.cooldownMs)) return false;
        state.cooldowns[fp] = now;
        return true;
      });
      rep.deliverable = deliverable.length;

      state.seens[category] = seen;
      await deps.saveState(state);

      if (deliverable.length > 0) {
        if (chats.length === 0) {
          log(`${category}: ${deliverable.length} events ready but no chats linked`);
        } else {
          const res = await deps.deliver(deliverable, chats);
          rep.delivered = res.delivered;
          report.totalDelivered += res.delivered;
        }
      }
      log(
        `${category}: universe=${rep.universe} scanned=${rep.scanned} signals=${rep.signals} ` +
          `events=${rep.events} deliverable=${rep.deliverable} delivered=${rep.delivered}`,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : "unknown scan error";
      rep.errors.push(msg);
      log(`${category}: ERROR ${msg}`);
      try {
        await deps.saveState(state);
      } catch {
        // best effort — next tick retries
      }
    }
    report.categories.push(rep);
  }
  return report;
}
