import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { defaultHistorySource } from "../History";
import { watchdogDisplay } from "../../components/ScannerHealth";
import { isStaleTimestamp } from "../../alerts/expiry";
import { BOTTOM_NAV, MORE_NAV, NAV } from "../../components/layout/AppLayout";
import { MIN_SCORE_OPTIONS } from "../Scanner";
import { fetchScannerHealth } from "../../supabase/history";
import { buildSignal } from "../../analysis/signal";
import { candlesFromCloses, uptrend } from "../../analysis/__tests__/helpers";
// Raw source reads for markup regression guards (vite ?raw — no node fs needed).
import appSrc from "../../App.tsx?raw";
import signalCardSrc from "../../components/SignalCard.tsx?raw";
import scannerHealthSrc from "../../components/ScannerHealth.tsx?raw";
import coinSrc from "../CoinAnalysis.tsx?raw";
import marketsSrc from "../Markets.tsx?raw";
import paperSrc from "../PaperTrading.tsx?raw";
import alertsSrc from "../Alerts.tsx?raw";
import dashboardSrc from "../Dashboard.tsx?raw";

const src = (...parts: string[]): string => {
  const key = parts.join("/");
  const table: Record<string, string> = {
    "components/SignalCard.tsx": signalCardSrc,
    "components/ScannerHealth.tsx": scannerHealthSrc,
    "pages/CoinAnalysis.tsx": coinSrc,
    "pages/Markets.tsx": marketsSrc,
    "pages/PaperTrading.tsx": paperSrc,
    "pages/Alerts.tsx": alertsSrc,
    "pages/Dashboard.tsx": dashboardSrc,
    "App.tsx": appSrc,
  };
  const hit = table[key] ?? table[parts.slice(-2).join("/")];
  if (typeof hit !== "string") throw new Error(`No raw source for ${key}`);
  return hit;
};

function fakeScannerClient(rows: unknown[]) {
  const query: Record<string, (...args: never[]) => unknown> = {};
  const self = () => query;
  query.select = self;
  query.in = self;
  (query as Record<string, unknown>).then = (resolvePromise: (v: unknown) => unknown) =>
    Promise.resolve({ data: rows, error: null }).then(resolvePromise);
  return {
    from: () => query,
  } as unknown as SupabaseClient;
}

describe("History source default (P1-9)", () => {
  it("signed in defaults to Cloud, signed out to device", () => {
    expect(defaultHistorySource(null, true)).toBe("server");
    expect(defaultHistorySource(null, false)).toBe("local");
  });

  it("never silently overwrites an explicit stored choice", () => {
    expect(defaultHistorySource("local", true)).toBe("local");
    expect(defaultHistorySource("server", false)).toBe("server");
  });
});

describe("watchdog display states (P1-10)", () => {
  it("labels healthy, stale and first-heartbeat distinctly", () => {
    expect(watchdogDisplay(false)).toMatch(/healthy/i);
    expect(watchdogDisplay(true)).toMatch(/stale/i);
    const waiting = watchdogDisplay(null);
    expect(waiting).toMatch(/waiting for first heartbeat/i);
    expect(waiting.toLowerCase()).not.toBe("unknown");
  });
});

describe("alert staleness (P1-11)", () => {
  it("marks alerts older than 24h stale and keeps fresh ones current", () => {
    const now = 1_800_000_000_000;
    expect(isStaleTimestamp(now - 1_000, now)).toBe(false);
    expect(isStaleTimestamp(now - 23 * 3_600_000, now)).toBe(false);
    expect(isStaleTimestamp(now - 25 * 3_600_000, now)).toBe(true);
    expect(isStaleTimestamp(0, now)).toBe(true);
  });
});

describe("mobile + sidebar navigation coverage (P1-7)", () => {
  it("every app route is reachable from sidebar or bottom navigation", () => {
    const destinations = [...NAV, ...BOTTOM_NAV, ...MORE_NAV].map((n) => n.to);
    for (const route of ["/", "/scanner", "/markets", "/alerts", "/watchlist", "/history", "/backtest", "/performance", "/paper", "/settings", "/bounce"]) {
      expect(destinations).toContain(route);
    }
    // Coin analysis is dynamic — at least one entry must carry a /coin/ prefix.
    expect(destinations.some((d) => d.startsWith("/coin/"))).toBe(true);
  });

  it("alerts, history and watchlist are reachable on mobile via More", () => {
    const more = MORE_NAV.map((n) => n.to);
    expect(more).toContain("/alerts");
    expect(more).toContain("/history");
    expect(more).toContain("/watchlist");
  });
});

describe("scanner min-score options (P1-3)", () => {
  it("offers ALL plus 60/70/80/90 bands", () => {
    expect([...MIN_SCORE_OPTIONS]).toEqual([0, 60, 70, 80, 90]);
  });
});

describe("scanner health mapping (P0-5 / P1-1 / P1-10)", () => {
  it("passes through lastDeliveryAt, universe counts and watchdog arming", async () => {
    const client = fakeScannerClient([
      {
        key: "cron-monitor",
        value: {
          lastRun: {
            at: 1_700_000_000_000,
            lastDeliveryAt: 1_699_999_000_000,
            perCategory: { crypto: { universe: 200, scanned: 40, signals: 5 } },
          },
        },
      },
      { key: "watchdog", value: { alertedAt: null } },
    ]);
    const { health, error } = await fetchScannerHealth(client);
    expect(error).toBeNull();
    expect(health?.lastRunAt).toBe(1_700_000_000_000);
    expect(health?.lastDeliveryAt).toBe(1_699_999_000_000);
    expect(health?.perCategory.crypto).toEqual({ universe: 200, scanned: 40, signals: 5 });
    expect(health?.watchdogAlerting).toBe(false);
  });

  it("reports null watchdog (no record yet) distinctly from alerting", async () => {
    const client = fakeScannerClient([{ key: "cron-monitor", value: { lastRun: { at: 1 } } }]);
    const { health } = await fetchScannerHealth(client);
    expect(health?.watchdogAlerting).toBeNull();
    expect(watchdogDisplay(health?.watchdogAlerting ?? null)).toMatch(/waiting for first heartbeat/i);
  });
});

describe("signal timestamps use engine time, not render time (P1-2)", () => {
  it("buildSignal stamps the actual signal time", () => {
    const before = Date.now();
    const candles = candlesFromCloses(uptrend(260));
    const { signal } = buildSignal({
      symbol: "BTC",
      setupTimeframe: "15m",
      candlesByTf: { "15m": candles, "5m": candles, "1h": candles, "4h": candles },
    });
    const after = Date.now();
    expect(signal.timestamp).toBeGreaterThanOrEqual(before);
    expect(signal.timestamp).toBeLessThanOrEqual(after);
  });

  it("signal cards render the generated time", () => {
    expect(src("components", "SignalCard.tsx")).toMatch(/Generated/);
  });
});

describe("P0/P1 markup regression guards", () => {
  it("P0-3: NotFound stays inside HashRouter via Link", () => {
    const app = src("App.tsx");
    expect(app).toMatch(/<Link to="\/"/);
    expect(app).not.toMatch(/<a href="\/"/);
  });

  it("P0-1: paper close requires confirmation content", () => {
    const paper = src("pages", "PaperTrading.tsx");
    expect(paper).toMatch(/Close this simulated position/);
    expect(paper).toMatch(/Est\. realized on close/);
    expect(paper).toMatch(/Close Position/);
  });

  it("P0-4: dashboard labels cloud vs device sources", () => {
    const dash = src("pages", "Dashboard.tsx");
    expect(dash).toMatch(/Latest Server Signals/);
    expect(dash).toMatch(/Device Signals/);
  });

  it("P0-5: signed-out dashboard names the login requirement", () => {
    expect(src("components", "ScannerHealth.tsx")).toMatch(/Sign in to view scanner health/);
  });

  it("P1-4: analysis has search, back, timeframe disclosure and S/R", () => {
    const coin = src("pages", "CoinAnalysis.tsx");
    expect(coin).toMatch(/Search any market/);
    expect(coin).toMatch(/← Back/);
    expect(coin).toMatch(/Signal timeframe is fixed at 15m/);
    expect(coin).toMatch(/Support \/ Resistance/);
  });

  it("P1-5: markets has a browsable directory and universe disclosure", () => {
    const markets = src("pages", "Markets.tsx");
    expect(markets).toMatch(/Market Directory/);
    expect(markets).toMatch(/highest-volume universe/);
    expect(markets).toMatch(/fixed at 15m/);
  });

  it("P1-6: paper shows cash, size, setup and fixed leverage", () => {
    const paper = src("pages", "PaperTrading.tsx");
    expect(paper).toMatch(/Cash \/ Available/);
    expect(paper).toMatch(/Notional/);
    expect(paper).toMatch(/fixed 1× leverage/);
    expect(paper).toMatch(/SL\/TP editing is not currently supported/);
    expect(paper).toMatch(/Not recorded/);
  });

  it("P1-11: alerts distinguish current vs stale with score filter and Telegram state", () => {
    const alerts = src("pages", "Alerts.tsx");
    expect(alerts).toMatch(/CURRENT/);
    expect(alerts).toMatch(/STALE/);
    expect(alerts).toMatch(/Minimum score|Score ≥/);
    expect(alerts).toMatch(/Telegram:/);
  });

  it("P1-1: dashboard shows paper, telegram, delivery and watchdog", () => {
    const dash = src("pages", "Dashboard.tsx");
    expect(dash).toMatch(/Paper Performance/);
    expect(dash).toMatch(/TelegramTeaser|Telegram/);
    expect(src("components", "ScannerHealth.tsx")).toMatch(/Last Telegram delivery/);
    expect(src("components", "ScannerHealth.tsx")).toMatch(/Waiting for first heartbeat/);
  });
});
