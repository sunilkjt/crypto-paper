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
import { getMarkets } from "./hyperliquid";
import { startMarketRealtime } from "./hyperliquid/realtime";
import { mergeLivePrices } from "./hyperliquid/markets";
import { wsManager } from "./ws";
import { isMarketsStale } from "./freshness";
import {
  applyRateLimitOverride,
  deriveConnection,
  type ConnectionState,
  type RateLimitView,
} from "./connection";
import { onVisible, pollAllowed } from "./visibility";
import { loadMarketsSnapshot, saveMarketsSnapshot } from "./persist";
import type { Market, MarketStatus } from "./hyperliquid/types";
import { HyperliquidError } from "./hyperliquid/types";

const POLL_MS = 30_000;

interface MarketDataValue {
  markets: Market[];
  /** Legacy data-availability flag kept for existing pages. */
  status: MarketStatus;
  /** Real connection state: earned by received data, never by page load. */
  connection: ConnectionState;
  /** Countdown view while rate limited (zeros otherwise). */
  rateLimit: RateLimitView;
  /** Epoch ms of the last observed 429 (0 = none). */
  rateLimitedAt: number;
  /** Shared-socket state for RECONNECTING display. */
  wsState: "open" | "connecting" | "idle";
  error: string | null;
  updatedAt: number;
  lastSuccessAt: number;
  consecutiveFailures: number;
  stale: boolean;
  refresh: () => void;
}

const MarketDataContext = createContext<MarketDataValue | null>(null);

const FRIENDLY_ERROR = "Unable to retrieve Hyperliquid market data. Retrying…";

function toMessage(err: unknown): string {
  if (err instanceof HyperliquidError) return err.message;
  if (err instanceof Error && err.message) return err.message;
  return FRIENDLY_ERROR;
}

/** Cancellations (refresh supersede / unmount) are not connection failures. */
function isCancellation(err: unknown): boolean {
  if (err instanceof DOMException && err.name === "AbortError") return true;
  return (
    err instanceof HyperliquidError &&
    err.kind === "network" &&
    /cancel/i.test(err.message)
  );
}

function initialSnapshot(): { markets: Market[]; updatedAt: number } {
  try {
    return loadMarketsSnapshot() ?? { markets: [], updatedAt: 0 };
  } catch {
    return { markets: [], updatedAt: 0 };
  }
}

export function MarketDataProvider({ children }: { children: ReactNode }) {
  const [boot] = useState(initialSnapshot);
  const [markets, setMarkets] = useState<Market[]>(boot.markets);
  // A restored snapshot is shown instantly but flagged stale until refreshed.
  const [status, setStatus] = useState<MarketStatus>(boot.markets.length > 0 ? "stale" : "loading");
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState(boot.updatedAt);
  const [lastSuccessAt, setLastSuccessAt] = useState(0);
  const [consecutiveFailures, setConsecutiveFailures] = useState(0);
  const [rateLimitedAt, setRateLimitedAt] = useState(0);
  const [wsState, setWsState] = useState<"open" | "connecting" | "idle">("idle");
  const [tick, setTick] = useState(0);
  const startedAtRef = useRef(Date.now());
  const abortRef = useRef<AbortController | null>(null);
  const marketsRef = useRef<Market[]>([]);
  marketsRef.current = markets;

  const recordSuccess = useCallback((at: number) => {
    setLastSuccessAt(at);
    setConsecutiveFailures(0);
    setError(null);
  }, []);

  const recordFailure = useCallback((err: unknown) => {
    if (isCancellation(err)) return;
    if (err instanceof HyperliquidError && err.kind === "rate-limited") {
      setRateLimitedAt(Date.now());
    }
    setConsecutiveFailures((f) => f + 1);
    setError(toMessage(err));
  }, []);

  const load = useCallback(async (isRefresh = false) => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    if (!isRefresh && marketsRef.current.length === 0) setStatus("loading");
    try {
      // Interval polls ride the 45s snapshot cache; only explicit refreshes
      // bypass it. Previously every 30s poll refetched ~11 dex payloads.
      const { markets: fresh, updatedAt: ts } = await getMarkets({
        signal: ctrl.signal,
        bypassCache: isRefresh,
      });
      setMarkets(fresh);
      setUpdatedAt(ts);
      setStatus("live");
      recordSuccess(ts);
      saveMarketsSnapshot({ markets: fresh, updatedAt: ts });
    } catch (err) {
      if (isCancellation(err)) return;
      recordFailure(err);
      // Keep last good snapshot; surface error only when we have nothing.
      if (marketsRef.current.length === 0) {
        setStatus("error");
      }
    }
  }, [recordSuccess, recordFailure]);

  const refresh = useCallback(() => {
    setTick((t) => t + 1);
    void load(true);
  }, [load]);

  // Initial load + slow poll for full snapshot (funding/OI/volume).
  // Hidden tabs skip polling; returning to the tab refreshes immediately.
  useEffect(() => {
    void load(false);
    const id = window.setInterval(() => {
      if (pollAllowed()) void load(false);
    }, POLL_MS);
    const offVisible = onVisible(() => void load(false));
    return () => {
      window.clearInterval(id);
      offVisible();
      abortRef.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick]);

  // Realtime ticks: WebSocket first, HTTPS polling fallback (see realtime.ts).
  useEffect(() => {
    const stop = startMarketRealtime(
      {
        onTick: (mids, _source, at) => {
          setMarkets((prev) => (prev.length === 0 ? prev : mergeLivePrices(prev, mids)));
          setUpdatedAt(at);
          setStatus((s) => (s === "error" ? s : "live"));
          setWsState(wsManager.connectionState === "open" ? "open" : "connecting");
          recordSuccess(at);
        },
        onPollError: (message) => {
          recordFailure(new Error(message));
        },
      },
    );
    return stop;
  }, [recordSuccess, recordFailure]);

  // Shared-socket state for the status UI (updates on ticks + failures).
  useEffect(() => {
    setWsState(wsManager.connectionState);
    const id = window.setInterval(() => setWsState(wsManager.connectionState), 5000);
    return () => window.clearInterval(id);
  }, [lastSuccessAt, consecutiveFailures]);

  const stale = useMemo(
    () => (updatedAt === 0 ? false : isMarketsStale(updatedAt)),
    [updatedAt],
  );

  const baseConnection = useMemo<ConnectionState>(
    () =>
      deriveConnection({
        lastSuccessAt,
        startedAt: startedAtRef.current,
        consecutiveFailures,
        hasData: markets.length > 0,
      }),
    [lastSuccessAt, consecutiveFailures, markets.length],
  );

  // RECONNECTING refines CONNECTING while the shared socket dials;
  // a recent 429 overrides everything with RATE LIMITED + countdown.
  const connection = useMemo<ConnectionState>(() => {
    if (baseConnection === "CONNECTING" && wsState === "connecting") return "RECONNECTING";
    return applyRateLimitOverride(baseConnection, rateLimitedAt).state;
  }, [baseConnection, wsState, rateLimitedAt, lastSuccessAt]);

  const rateLimit = useMemo(
    () => applyRateLimitOverride(baseConnection, rateLimitedAt).view,
    [baseConnection, rateLimitedAt, lastSuccessAt],
  );

  // Legacy vocabulary for existing pages (signal math untouched).
  const legacyStatus = useMemo<MarketStatus>(() => {
    if (status === "live" && stale) return "stale";
    if (connection === "RATE_LIMITED") return "stale";
    if (connection === "RECONNECTING") return "loading";
    return status;
  }, [status, stale, connection]);

  const value = useMemo<MarketDataValue>(
    () => ({
      markets,
      status: legacyStatus,
      connection,
      rateLimit,
      rateLimitedAt,
      wsState,
      error,
      updatedAt,
      lastSuccessAt,
      consecutiveFailures,
      stale,
      refresh,
    }),
    [markets, legacyStatus, connection, rateLimit, rateLimitedAt, wsState, error, updatedAt, lastSuccessAt, consecutiveFailures, stale, refresh],
  );

  return <MarketDataContext.Provider value={value}>{children}</MarketDataContext.Provider>;
}

export function useMarkets(): MarketDataValue {
  const ctx = useContext(MarketDataContext);
  if (!ctx) throw new Error("useMarkets must be used inside MarketDataProvider");
  return ctx;
}
