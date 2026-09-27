import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { Timeframe } from "../market/hyperliquid/types";
import { useMarkets } from "../market/store";
import { runFullScan, type ScanSummary } from "./engine";
import { DEFAULT_ELIGIBILITY } from "./eligibility";
import { onVisible, pollAllowed } from "../market/visibility";
import {
  loadJournal,
  nextLifecycleState,
  upsertJournalSignal,
  type SignalLifecycleState,
} from "../signals";
import {
  ingestAlertEvents,
  loadAlertSettings,
  setAlertProviders,
  type SignalEvent,
} from "../alerts";
import { evaluateScan, evaluateTargets, type MonitorSnapshot } from "../alerts/monitor";
import {
  BrowserNotificationProvider,
  SoundAlertProvider,
  TelegramNotificationProvider,
  telegramEndpointFromEnv,
} from "../alerts/providers";
import { isExpired, DEFAULT_MAX_SIGNAL_AGE_MS } from "../alerts/expiry";
import { loadWatchlist } from "../alerts/watchlist";

/**
 * Shared scan context: ONE full-market scan feeds Scanner, Bounce,
 * Dashboard and History. Refresh OFF/30s/1m/5m, manual rescan, bounded
 * concurrency, per-coin isolation. Journal + lifecycle + alert events
 * update here; outcomes refresh on the History page (bounded).
 * Stale market data pauses new scans — never mint signals from stale data.
 * AI and news are never consulted by the monitor (engine-only alerts).
 */

export const REFRESH_OPTIONS = [
  { label: "OFF", ms: 0 },
  { label: "30s", ms: 30_000 },
  { label: "1m", ms: 60_000 },
  { label: "5m", ms: 300_000 },
] as const;

export const UNIVERSE_OPTIONS = [20, 40, 60] as const;

interface ScanContextValue {
  summary: ScanSummary | null;
  scanning: boolean;
  progress: { done: number; total: number };
  setupTimeframe: Timeframe;
  setSetupTimeframe: (tf: Timeframe) => void;
  universeSize: number;
  setUniverseSize: (n: number) => void;
  refreshMs: number;
  setRefreshMs: (ms: number) => void;
  refresh: () => void;
  pausedStale: boolean;
}

const ScanContext = createContext<ScanContextValue | null>(null);

export function ScanProvider({ children }: { children: ReactNode }) {
  const { markets, stale } = useMarkets();
  const [summary, setSummary] = useState<ScanSummary | null>(null);
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [setupTimeframe, setSetupTimeframe] = useState<Timeframe>("15m");
  const [universeSize, setUniverseSize] = useState<number>(40);
  const [refreshMs, setRefreshMs] = useState<number>(60_000);
  const [runId, setRunId] = useState(0);
  const [pausedStale, setPausedStale] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const prevIdsRef = useRef<Map<string, MonitorSnapshot>>(new Map());
  const soundRef = useRef<SoundAlertProvider | null>(null);
  const marketsRef = useRef(markets);
  marketsRef.current = markets;

  // Seed seen-IDs from persisted alert history so a reload never
  // replays hundreds of old alerts as NEW.
  useEffect(() => {
    try {
      const raw = localStorage.getItem("cryptoin:alert-events:v1");
      if (!raw) return;
      const parsed = JSON.parse(raw) as { id?: unknown; currentStrength?: unknown }[];
      if (!Array.isArray(parsed)) return;
      const seeded = new Map<string, MonitorSnapshot>();
      for (const e of parsed) {
        if (typeof e?.id !== "string") continue;
        const signalId = e.id.split("::")[0];
        if (signalId && !seeded.has(signalId) && typeof e.currentStrength === "number") {
          seeded.set(signalId, { strength: e.currentStrength, status: "ACTIVE" });
        }
      }
      prevIdsRef.current = seeded;
    } catch {
      // storage unavailable — first scan may notify, dedupe still holds after
    }
  }, []);

  const runScan = useCallback(async () => {
    const snapshot = marketsRef.current;
    if (snapshot.length === 0) return;
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setScanning(true);
    setProgress({ done: 0, total: 0 });
    try {
      const result = await runFullScan(snapshot, {
        eligibility: { ...DEFAULT_ELIGIBILITY, universeSize },
        setupTimeframe,
        concurrency: 6,
        onProgress: (done, total) => setProgress({ done, total }),
        signal: ctrl.signal,
      });
      if (ctrl.signal.aborted) return;
      setSummary(result);

      // Alert providers follow user settings (browser/sound on explicit
      // enable only; telegram only with a configured backend endpoint).
      const alertSettings = loadAlertSettings();
      if (!soundRef.current) soundRef.current = new SoundAlertProvider();
      soundRef.current.setEnabled(alertSettings.soundAlerts);
      setAlertProviders([
        new BrowserNotificationProvider(),
        soundRef.current,
        new TelegramNotificationProvider(telegramEndpointFromEnv()),
      ]);
      const watchlist = loadWatchlist();
      const marks = new Map(snapshot.map((m) => [m.symbol, m.markPrice]));
      const monitorCtx = {
        marks,
        watchlist,
        settings: alertSettings,
        now: Date.now(),
      };

      // Lifecycle + journal (prices from the same snapshot).
      const prices = marks;
      const seen = new Map<string, MonitorSnapshot>();
      const lifecycleById = new Map<string, string>();
      const journalEntries = loadJournal();
      for (const r of result.results) {
        if (!r.id || r.signal.direction === "WAIT") continue;
        const prev = journalEntries.find((e) => e.id === r.id);
        const price = prices.get(r.symbol) ?? null;
        const prevState =
          (prev?.status ?? prevIdsRef.current.get(r.id)?.status ?? null) as SignalLifecycleState | null;
        const prevStrength = prev?.strength ?? prevIdsRef.current.get(r.id)?.strength ?? null;
        const status = nextLifecycleState({
          previous: prevState,
          previousStrength: prevStrength,
          strength: r.signal.signalStrength,
          price,
          invalidation: r.signal.invalidation,
          tp3: r.signal.tp3,
          direction: r.signal.direction,
        });
        // Expiry: outlived structure or lifetime — journal it, never alert it.
        const firstSeen = prev?.firstSeen ?? Date.now();
        const expired = isExpired({ firstSeen, strength: r.signal.signalStrength, now: Date.now(), maxAgeMs: DEFAULT_MAX_SIGNAL_AGE_MS });
        const finalStatus = expired ? "EXPIRED" : status;
        upsertJournalSignal({
          id: r.id,
          symbol: r.symbol,
          direction: r.signal.direction,
          setupType: r.setupType,
          timeframe: r.signal.timeframe,
          entryLow: r.signal.entryLow,
          entryHigh: r.signal.entryHigh,
          invalidation: r.signal.invalidation,
          tp1: r.signal.tp1,
          tp2: r.signal.tp2,
          tp3: r.signal.tp3,
          riskReward: r.signal.riskReward,
          strength: r.signal.signalStrength,
          quality: r.quality,
          status: finalStatus,
          outcome: prev?.outcome ?? null,
          newsHeadlines: [],
          dataTimestamp: r.signal.dataTimestamp,
        });
        lifecycleById.set(r.id, finalStatus);
        seen.set(r.id, { status: finalStatus, strength: r.signal.signalStrength });
      }

      // Engine-only alert events: scan diff + live-mark target touches.
      const scanEvents = evaluateScan(prevIdsRef.current, result.results, lifecycleById, monitorCtx);
      const targetEvents = evaluateTargets(result.results, marks, monitorCtx);
      const fresh: SignalEvent[] = ingestAlertEvents([...scanEvents, ...targetEvents]);
      void fresh;
      prevIdsRef.current = seen;
    } catch {
      // runFullScan isolates per-coin errors; a throw here is fatal only.
      setSummary((prev) =>
        prev === null
          ? {
              status: "ERROR",
              startedAt: Date.now(),
              completedAt: Date.now(),
              setupTimeframe,
              results: [],
              scanned: 0,
              excluded: [],
              error: "Market-data failure — scanner reports the outage, app stays up.",
              breadth: { bullishPct: 0, bearishPct: 0, neutralPct: 0, counted: 0 },
            }
          : prev,
      );
    } finally {
      if (!ctrl.signal.aborted) setScanning(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [universeSize, setupTimeframe]);

  const refresh = useCallback(() => {
    setRunId((n) => n + 1);
  }, []);

  // Trigger: manual, config change, interval — skipped while stale.
  useEffect(() => {
    if (markets.length === 0) return;
    if (stale) {
      setPausedStale(true);
      return;
    }
    setPausedStale(false);
    void runScan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, setupTimeframe, universeSize, markets.length, stale]);

  useEffect(() => {
    if (refreshMs <= 0 || markets.length === 0) return;
    // Hidden tabs pause expensive full-market scans; returning refreshes.
    const id = window.setInterval(() => {
      if (pollAllowed()) setRunId((n) => n + 1);
    }, refreshMs);
    const offVisible = onVisible(() => setRunId((n) => n + 1));
    return () => {
      window.clearInterval(id);
      offVisible();
    };
  }, [refreshMs, markets.length]);

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  const value = useMemo<ScanContextValue>(
    () => ({
      summary,
      scanning,
      progress,
      setupTimeframe,
      setSetupTimeframe,
      universeSize,
      setUniverseSize,
      refreshMs,
      setRefreshMs,
      refresh,
      pausedStale,
    }),
    [summary, scanning, progress, setupTimeframe, universeSize, refreshMs, refresh, pausedStale],
  );

  return <ScanContext.Provider value={value}>{children}</ScanContext.Provider>;
}

export function useScan(): ScanContextValue {
  const ctx = useContext(ScanContext);
  if (!ctx) throw new Error("useScan must be used inside ScanProvider");
  return ctx;
}
