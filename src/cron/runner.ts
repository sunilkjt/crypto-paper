import { evaluateScan, evaluateTargets, type MonitorSnapshot } from "../alerts/monitor";
import { fingerprintOf, isOutsideCooldown } from "../alerts/cooldown";
import type { ClaimFn, ReleaseFn } from "./claims";
import { resolveEventCategory, type SignalEvent } from "../alerts/events";
import type { AlertSettings } from "../alerts/settings";
import { nextLifecycleState, type SignalLifecycleState } from "../signals";
import { DEFAULT_MAX_SIGNAL_AGE_MS, isExpired } from "../alerts/expiry";
import type { MarketCategory } from "../market/classify";
import type { Market } from "../market/hyperliquid/types";
import type { ScanSummary } from "../scanner/engine";
import { buildUniverse, mainDexSymbols } from "./universe";
import type { CronState, SeenEntry } from "./state";
import type { HistoryRow } from "./history";
import { classifyExcluded, classifyWait, topReasons, type RejectionCode } from "./diagnostics";

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
  saveHistory: (rows: HistoryRow[]) => Promise<void>;
  /** Shared atomic gate; must resolve false only when another worker won. */
  claim: ClaimFn;
  /** Burns a won claim after a failed send so retries may proceed. */
  release: ReleaseFn;
  listChats: () => Promise<string[]>;
  deliver: (events: SignalEvent[], chats: string[]) => Promise<{ delivered: number }>;
  log?: (msg: string) => void;
}

export interface CategoryReport {
  category: MarketCategory;
  universe: number;
  scanned: number;
  signals: number;
  /** Non-WAIT results (directional setups, before notification gating). */
  candidates: number;
  events: number;
  deliverable: number;
  delivered: number;
  suppressed: number;
  /** Diagnostic-only rejection buckets (never alters scoring). */
  rejections: Record<string, number>;
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
  const historyRows: HistoryRow[] = [];

  for (const category of settings.categories) {
    const rep: CategoryReport = {
      category,
      universe: 0,
      scanned: 0,
      signals: 0,
      candidates: 0,
      events: 0,
      deliverable: 0,
      delivered: 0,
      suppressed: 0,
      rejections: {},
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
      rep.candidates = rep.signals;
      // Diagnostic-only rejection buckets over already-computed fields.
      const rej: Record<string, number> = {};
      const bump = (code: RejectionCode) => {
        rej[code] = (rej[code] ?? 0) + 1;
      };
      for (const r of summary.results) {
        if (r.signal.direction !== "WAIT" && r.signal.signalStrength >= settings.minStrength) continue;
        if (r.signal.signalStrength < settings.minStrength) {
          bump("LOW_SCORE");
          continue;
        }
        bump(
          classifyWait({
            strength: r.signal.signalStrength,
            minStrength: settings.minStrength,
            mtfConflict: r.signal.multiTimeframe?.conflict === true,
            riskReward: r.signal.riskReward,
            volumeLow: r.signal.volume === "LOW",
          }),
        );
      }
      for (const x of summary.excluded) bump(classifyExcluded(x.reason));
      rep.rejections = rej;

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

      // Atomic cross-worker claim per event, with local-map fallback when
      // the gate is unreachable (legacy semantics preserved exactly).
      const gated: { event: SignalEvent; fp: string }[] = [];
      for (const e of events) {
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
        let allowed: boolean;
        try {
          const claimed = await deps.claim(fp, settings.cooldownMs);
          if (claimed === null) {
            allowed = isOutsideCooldown(state.cooldowns[fp], now, settings.cooldownMs);
          } else {
            allowed = claimed;
          }
        } catch {
          allowed = isOutsideCooldown(state.cooldowns[fp], now, settings.cooldownMs);
        }
        if (!allowed) {
          rep.suppressed += 1;
          continue;
        }
        state.cooldowns[fp] = now;
        gated.push({ event: e, fp });
      }
      const deliverable = gated.map((g) => g.event);
      rep.deliverable = deliverable.length;

      state.seens[category] = seen;
      await deps.saveState(state);

      // Server-side signal history: every qualifying signal (non-WAIT at
      // or above the notify bar), independent of delivery success, so pull
      // commands read the same history the push path used.
      for (const r of summary.results) {
        if (!r.id || r.signal.direction === "WAIT") continue;
        if (r.signal.signalStrength < settings.minStrength) continue;
        const entry = seen[r.id];
        historyRows.push({
          id: r.id,
          category,
          symbol: r.symbol,
          direction: r.signal.direction,
          // DB column is integer while the engine scores fractional: round
          // at the write boundary only. Qualification above still uses the
          // raw float, so thresholds are untouched.
          score: Math.round(r.signal.signalStrength),
          timeframe: r.signal.timeframe,
          entry_low: r.signal.entryLow,
          entry_high: r.signal.entryHigh,
          invalidation: r.signal.invalidation,
          tp1: r.signal.tp1,
          tp2: r.signal.tp2,
          tp3: r.signal.tp3,
          risk_reward: r.signal.riskReward,
          setup_type: r.setupType,
          quality: r.quality,
          // Entry type rides along for activation-gated analytics (null for
          // WAIT, which is never written). Formulas untouched.
          entry_type: r.signal.entryType,
          status: entry?.status ?? lifecycleById.get(r.id) ?? "NEW",
          first_seen: new Date(entry?.firstSeen ?? now).toISOString(),
          last_seen: new Date(now).toISOString(),
        });
      }

      if (gated.length > 0) {
        if (chats.length === 0) {
          log(`${category}: ${gated.length} events ready but no chats linked`);
        } else {
          for (const g of gated) {
            try {
              const res = await deps.deliver([g.event], chats);
              rep.delivered += res.delivered;
              report.totalDelivered += res.delivered;
            } catch (e) {
              // Failed send must not read as delivered: burn the won claim
              // (server + local) so a later attempt may retry instead of
              // being cooldown-suppressed. History + lifecycle unaffected.
              try {
                await deps.release(g.fp);
              } catch {
                // ignore
              }
              delete state.cooldowns[g.fp];
              const msg = e instanceof Error ? e.message : "delivery failed";
              rep.errors.push(`delivery: ${msg}`);
              log(`${category}: delivery ERROR ${msg}`);
            }
          }
        }
      }
      const top = topReasons(rep.rejections, 3)
        .map(([code, n]) => `${code}:${n}`)
        .join(" ");
      log(
        `${category}: universe=${rep.universe} scanned=${rep.scanned} signals=${rep.signals} ` +
          `events=${rep.events} deliverable=${rep.deliverable} delivered=${rep.delivered} suppressed=${rep.suppressed}` +
          (top ? ` top-rejections=${top}` : ""),
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

  if (historyRows.length > 0) {
    try {
      await deps.saveHistory(historyRows);
      log(`history: upserted ${historyRows.length} rows`);
    } catch (e) {
      log(`history: FAILED ${e instanceof Error ? e.message : "unknown"} (scan results unaffected)`);
    }
  }

  // Heartbeat for /status: fresh timestamps prove liveness; missing or
  // stale heartbeats render as delayed. Never throws the run.
  try {
    const perCategory: Record<string, { universe: number; scanned: number; signals: number }> = {};
    for (const rep of report.categories) {
      perCategory[rep.category] = { universe: rep.universe, scanned: rep.scanned, signals: rep.signals };
    }
    const prevDelivery = state.lastRun?.lastDeliveryAt ?? null;
    state.lastRun = {
      at: now,
      perCategory,
      delivered: report.totalDelivered,
      lastDeliveryAt: report.totalDelivered > 0 ? now : prevDelivery,
    };
    await deps.saveState(state);
  } catch (e) {
    log(`heartbeat: FAILED ${e instanceof Error ? e.message : "unknown"}`);
  }
  return report;
}
