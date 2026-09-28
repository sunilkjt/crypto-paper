import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import type { PaperEngine } from "../paper/engine";
import type { PaperSnapshot } from "../paper";
import { getSupabase, isSupabaseConfigured } from "./client";
import { useAuth } from "./auth";
import {
  closedToTradeRow,
  decideInitialLoad,
  ensurePaperAccount,
  fetchPositions,
  fetchTrades,
  positionToRow,
  recordEquitySnapshot,
  rowToPosition,
  upsertAccount,
  upsertPositionRow,
  upsertTradeRow,
} from "./paperCloud";
import type { CloudSyncStatus, PaperAccountRow } from "./types";

const MIGRATION_FLAG = (uid: string) => `cryptoin:paper-migrated:${uid}`;
const LAST_EXIT_KEY = "cryptoin:paper-last-exit:v1";

export interface PaperCloudSync {
  status: CloudSyncStatus;
  account: PaperAccountRow | null;
  /**
   * True once the initial cloud load for the current user has completed.
   * Until then the local engine may still hold pre-login defaults and MUST
   * NOT be displayed as the account nor pushed back to Supabase.
   */
  hydrated: boolean;
  needsMigration: boolean;
  migrated: boolean;
  lastError: string | null;
  lastSyncedAt: number | null;
  migrate: () => Promise<boolean>;
  retry: () => void;
}

function isLocalDataMeaningful(snap: PaperSnapshot): boolean {
  return snap.positions.length > 0 || snap.closedCount > 0 || snap.balance !== snap.config.startingBalance;
}

/**
 * Binds the shared PaperEngine to Supabase for the signed-in user.
 * - Login: ensure account (no reset), pull cloud, replace local snapshot.
 * - Local edits: debounced push (account + changed positions + new trades).
 * - Realtime: apply remote position/trade/account changes incrementally.
 * - Offline: status flag only; local engine keeps working; pushes retry.
 * - Idempotency: PK = engine id + upsert; echo suppression via write window.
 */
export function usePaperCloudSync(engine: PaperEngine, marks: Map<string, number>): PaperCloudSync {
  const { user, configured } = useAuth();
  const [account, setAccount] = useState<PaperAccountRow | null>(null);
  const [status, setStatus] = useState<CloudSyncStatus>(() =>
    !isSupabaseConfigured() ? "disabled" : "signed-out",
  );
  const [lastError, setLastError] = useState<string | null>(null);
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  const [needsMigration, setNeedsMigration] = useState(false);
  const [migrated, setMigrated] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [nonce, setNonce] = useState(0);

  const accountRef = useRef<PaperAccountRow | null>(null);
  const suppressUntil = useRef(0); // Echo window after applying remote data.
  const pushing = useRef(false);
  const pushTimer = useRef<number | null>(null);
  const lastPushedSig = useRef("");
  const lastExitRef = useRef<Map<string, number | null>>(new Map());
  const channelRef = useRef<RealtimeChannel | null>(null);
  const snapshotRef = useRef<number>(0);
  // Hydration gate: pushes are forbidden until the initial cloud load for the
  // current user completes. This is THE fix for fresh-device logins
  // overwriting the cloud account with local $1,000 defaults.
  const hydratedRef = useRef(false);
  // Fresh-value refs so debounced pushes never capture stale closures.
  const marksRef = useRef(marks);
  const userRef = useRef(user);

  accountRef.current = account;
  marksRef.current = marks;
  userRef.current = user;

  const online = useCallback(() => (typeof navigator === "undefined" ? true : navigator.onLine !== false), []);

  // ---- Initial load on login ------------------------------------------------
  useEffect(() => {
    if (!configured || !isSupabaseConfigured()) {
      setStatus("disabled");
      setAccount(null);
      return;
    }
    if (!user) {
      // Signed out: tear down realtime, stay local.
      if (channelRef.current) {
        const sb = getSupabase();
        if (sb) void sb.removeChannel(channelRef.current);
        channelRef.current = null;
      }
      setAccount(null);
      setNeedsMigration(false);
      setHydrated(false);
      hydratedRef.current = false;
      lastPushedSig.current = "";
      setStatus("signed-out");
      return;
    }
    let cancelled = false;
    const mySnapshot = ++snapshotRef.current;
    // A (re-)login starts unhydrated: any engine emission from here on is
    // pre-cloud state and must neither display as truth nor push.
    hydratedRef.current = false;
    setHydrated(false);
    lastPushedSig.current = "";
    (async () => {
      setStatus("loading");
      setLastError(null);
      const sb = getSupabase();
      if (!sb) {
        setStatus("disabled");
        return;
      }
      const local = engine.getSnapshot();
      const { account: acc, error } = await ensurePaperAccount(sb, local.config.startingBalance);
      if (cancelled || mySnapshot !== snapshotRef.current) return;
      if (!acc || error) {
        setLastError(error ?? "Could not load paper account.");
        setStatus(online() ? "error" : "offline");
        return;
      }
      setAccount(acc);
      const [{ rows: posRows, error: pErr }, { rows: tradeRows, error: tErr }] = await Promise.all([
        fetchPositions(sb, acc.id),
        fetchTrades(sb, acc.id),
      ]);
      if (cancelled || mySnapshot !== snapshotRef.current) return;
      if (pErr || tErr) {
        setLastError(pErr ?? tErr ?? "Could not load cloud positions.");
        setStatus(online() ? "error" : "offline");
        // Still subscribe realtime so a retry can heal.
      } else {
        const localMeaningful = isLocalDataMeaningful(local);
        const alreadyMigrated =
          typeof localStorage !== "undefined" && localStorage.getItem(MIGRATION_FLAG(user.id)) === "1";
        // Cloud wins whenever it holds anything (decideInitialLoad is pure +
        // unit-tested). Empty cloud + meaningful local -> offer safe import.
        const decision = decideInitialLoad(local, acc, posRows, tradeRows);
        if (decision.replace && decision.snapshot) {
          suppressUntil.current = Date.now() + 3000;
          engine.replaceSnapshot(decision.snapshot);
          lastPushedSig.current = sigOf(engine.getSnapshot());
          setNeedsMigration(false);
          setMigrated(alreadyMigrated);
        } else if (localMeaningful && !alreadyMigrated) {
          setNeedsMigration(true);
          setMigrated(false);
          lastPushedSig.current = sigOf(engine.getSnapshot());
        } else {
          setNeedsMigration(false);
          setMigrated(alreadyMigrated);
          lastPushedSig.current = sigOf(engine.getSnapshot());
        }
        // Seed exit-price memory for trade rows (avoids fake exit on first push).
        const exits = new Map<string, number | null>();
        for (const t of tradeRows) exits.set(t.id, t.exit_price);
        lastExitRef.current = exits;
        try {
          localStorage?.setItem(LAST_EXIT_KEY, JSON.stringify(Object.fromEntries(exits)));
        } catch { /* ignore */ }
        hydratedRef.current = true;
        setHydrated(true);
        setStatus("synced");
        setLastSyncedAt(Date.now());
      }

      // ---- Realtime (one channel per account; cleaned on logout/unmount) ----
      try {
        if (channelRef.current) await sb.removeChannel(channelRef.current);
        const ch = sb
          .channel(`paper-${acc.id}`)
          .on(
            "postgres_changes",
            { event: "*", schema: "public", table: "paper_positions", filter: `account_id=eq.${acc.id}` },
            (payload) => {
              const row = (payload.new ?? payload.old) as { id?: string } | undefined;
              void pullPositions(row?.id);
            },
          )
          .on(
            "postgres_changes",
            { event: "*", schema: "public", table: "paper_trades", filter: `account_id=eq.${acc.id}` },
            (payload) => {
              const row = (payload.new ?? payload.old) as { id?: string } | undefined;
              void pullTrades(row?.id);
            },
          )
          .on(
            "postgres_changes",
            { event: "UPDATE", schema: "public", table: "paper_accounts", filter: `id=eq.${acc.id}` },
            (payload) => {
              const next = payload.new as PaperAccountRow;
              if (!next || Date.now() < suppressUntil.current) return;
              suppressUntil.current = Date.now() + 2000;
              engine.applyRemoteAccountTotals({
                balance: next.current_balance,
                realizedPnl: next.realized_pnl,
                feesPaid: next.fees_paid,
                closedCount: next.closed_count,
                wins: next.wins,
                peakEquity: next.peak_equity,
                maxDrawdownPct: next.max_drawdown_pct,
                config: {
                  startingBalance: next.starting_balance,
                  riskPerTrade: next.risk_per_trade,
                  feeRate: next.fee_rate,
                  autoPaperTrading: next.auto_paper_trading,
                  autoMinStrength: next.auto_min_strength,
                },
              });
              setAccount(next);
              lastPushedSig.current = sigOf(engine.getSnapshot());
            },
          )
          .subscribe();
        channelRef.current = ch;
      } catch {
        // Realtime optional; polling via engine subscription still pushes.
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, configured, nonce]);

  const pullPositions = useCallback(
    async (hintId?: string) => {
      const sb = getSupabase();
      const acc = accountRef.current;
      if (!sb || !acc || Date.now() < suppressUntil.current) return;
      const { rows, error } = await fetchPositions(sb, acc.id);
      if (error || rows.length === 0) return;
      const apply = hintId ? rows.filter((r) => r.id === hintId) : rows.slice(0, 25);
      let changed = false;
      for (const r of apply.length > 0 ? apply : rows.slice(0, 25)) {
        const p = rowToPosition(r);
        const cur = engine.getSnapshot().positions.find((x) => x.id === p.id);
        if (!cur) {
          suppressUntil.current = Date.now() + 2000;
          engine.mergeRemotePosition(p);
          changed = true;
        } else if (JSON.stringify(cur) !== JSON.stringify(p)) {
          // Remote newer or different (e.g. closed on phone) -> adopt.
          if ((p.closedAt ?? 0) >= (cur.closedAt ?? 0)) {
            suppressUntil.current = Date.now() + 2000;
            engine.mergeRemotePosition(p);
            changed = true;
          }
        }
      }
      if (changed) {
        lastPushedSig.current = sigOf(engine.getSnapshot());
        setLastSyncedAt(Date.now());
        setStatus("synced");
      }
    },
    [engine],
  );

  const pullTrades = useCallback(
    async (hintId?: string) => {
      const sb = getSupabase();
      const acc = accountRef.current;
      if (!sb || !acc || Date.now() < suppressUntil.current) return;
      const { rows, error } = await fetchTrades(sb, acc.id);
      if (error || rows.length === 0) return;
      const list = hintId ? rows.filter((r) => r.id === hintId) : rows.slice(0, 25);
      let changed = false;
      for (const t of list) {
        if (engine.getSnapshot().positions.some((x) => x.id === t.id)) continue;
        suppressUntil.current = Date.now() + 2000;
        engine.mergeRemotePosition({
          id: t.id,
          symbol: t.symbol,
          timeframe: t.timeframe ?? "15m",
          setupType: t.setup_type ?? "CLOUD",
          direction: t.side,
          entry: t.entry_price,
          size: t.quantity,
          notional: t.quantity * t.entry_price,
          margin: t.quantity * t.entry_price,
          risk: 0,
          invalidation: t.stop_loss ?? t.entry_price,
          tp1: t.tp1 ?? t.take_profit ?? t.entry_price,
          tp2: t.tp2 ?? t.take_profit ?? t.entry_price,
          tp3: t.tp3 ?? t.take_profit ?? t.entry_price,
          strength: t.strength ?? 0,
          status: ((t.result as PaperSnapshot["positions"][number]["status"]) ?? "CLOSED"),
          thirdsRemaining: 0,
          realized: t.realized_pnl + t.fees,
          fees: t.fees,
          openedAt: t.opened_at ? Date.parse(t.opened_at) : Date.now(),
          closedAt: t.closed_at ? Date.parse(t.closed_at) : Date.now(),
          closeReason: t.close_reason,
        });
        changed = true;
      }
      if (changed) {
        lastPushedSig.current = sigOf(engine.getSnapshot());
        setLastSyncedAt(Date.now());
        setStatus("synced");
      }
    },
    [engine],
  );

  // ---- Local -> cloud push (debounced, idempotent, honest status) -----------
  // Two guards fix the fresh-login clobber bug:
  // 1. Nothing pushes before hydration (the immediate subscribe() emission and
  //    any pre-cloud commit carry local defaults, never the account).
  // 2. The timer carries no snapshot closure — pushSnapshot re-reads the live
  //    engine state at fire time and re-checks the signature.
  useEffect(() => {
    if (!user || !account) return;
    return engine.subscribe((snap) => {
      if (!hydratedRef.current) return;
      if (Date.now() < suppressUntil.current) {
        lastPushedSig.current = sigOf(snap);
        return;
      }
      const sig = sigOf(snap);
      if (sig === lastPushedSig.current) return;
      if (pushTimer.current !== null) window.clearTimeout(pushTimer.current);
      setStatus((s) => (s === "synced" || s === "signed-out" ? "syncing" : s));
      pushTimer.current = window.setTimeout(() => void pushSnapshot(), 900);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, user?.id, account?.id]);

  const pushSnapshot = useCallback(
    async () => {
      const sb = getSupabase();
      const acc = accountRef.current;
      const u = userRef.current;
      const liveMarks = marksRef.current;
      if (!sb || !acc || !u) return;
      if (!hydratedRef.current) return; // Never push pre-cloud state.
      if (pushing.current) return; // Debounce already coalesces; skip overlap.
      if (!online()) {
        setStatus("offline");
        return;
      }
      const snap = engine.getSnapshot(); // Fresh read — never a stale closure.
      if (sigOf(snap) === lastPushedSig.current) return;
      pushing.current = true;
      setStatus("syncing");
      try {
        const accErr = await upsertAccount(sb, acc.id, snap);
        if (accErr) throw new Error(accErr);
        // Push positions: opens + recently closed (cap 200 newest).
        const rows = snap.positions.slice(0, 200);
        for (const p of rows) {
          const mark = liveMarks.get(p.symbol) ?? null;
          const err = await upsertPositionRow(sb, positionToRow(p, acc.id, u.id, mark));
          if (err) throw new Error(err);
        }
        // Mirror newly-closed positions into immutable trade history (once each).
        for (const p of snap.positions) {
          if (p.closedAt === null) continue;
          if (lastExitRef.current.has(p.id)) continue; // Already mirrored.
          const mark = liveMarks.get(p.symbol) ?? null;
          // Exit price: prefer live mark at push time; fall back to SL/TP3 semantics
          // stored in closeReason is free-text, so live mark is the honest exit.
          const err = await upsertTradeRow(sb, closedToTradeRow(p, acc.id, u.id, mark));
          if (err) throw new Error(err);
          lastExitRef.current.set(p.id, mark);
        }
        try {
          localStorage?.setItem(LAST_EXIT_KEY, JSON.stringify(Object.fromEntries(lastExitRef.current)));
        } catch { /* ignore */ }
        lastPushedSig.current = sigOf(snap);
        setStatus("synced");
        setLastError(null);
        setLastSyncedAt(Date.now());
        // Throttled equity curve point (best-effort, ~1/min max).
        const lastEq = (pushSnapshot as { _eqAt?: number })._eqAt ?? 0;
        if (Date.now() - lastEq > 60_000) {
          (pushSnapshot as { _eqAt?: number })._eqAt = Date.now();
          const unreal = snap.positions
            .filter((p) => p.closedAt === null)
            .reduce((a, p) => {
              const m = liveMarks.get(p.symbol);
              if (m === undefined) return a;
              const rem = (p.size / 3) * p.thirdsRemaining;
              return a + (p.direction === "LONG" ? m - p.entry : p.entry - m) * rem;
            }, 0);
          void recordEquitySnapshot(sb, acc.id, u.id, snap.balance + unreal, snap.balance, unreal);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Sync failed.";
        setLastError(msg); // Never claim saved when the DB rejected it.
        setStatus(online() ? "error" : "offline");
      } finally {
        pushing.current = false;
      }
    },
    [engine],
  );

  // ---- Offline/online transitions -------------------------------------------
  useEffect(() => {
    const onOff = () => setStatus((s) => (s === "syncing" || s === "synced" ? "offline" : s));
    const onOn = () => {
      if (user && account) {
        setStatus("syncing");
        void pushSnapshot();
      }
    };
    window.addEventListener("offline", onOff);
    window.addEventListener("online", onOn);
    return () => {
      window.removeEventListener("offline", onOff);
      window.removeEventListener("online", onOn);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, account?.id]);

  // ---- Safe localStorage -> cloud migration ----------------------------------
  const migrate = useCallback(async (): Promise<boolean> => {
    const sb = getSupabase();
    const acc = accountRef.current;
    if (!sb || !acc || !user) {
      setLastError("Sign in first, then import.");
      return false;
    }
    setStatus("syncing");
    setLastError(null);
    try {
      const snap = engine.getSnapshot();
      const accErr = await upsertAccount(sb, acc.id, snap);
      if (accErr) throw new Error(accErr);
      for (const p of snap.positions.slice(0, 500)) {
        const mark = marks.get(p.symbol) ?? null;
        const err = await upsertPositionRow(sb, positionToRow(p, acc.id, user.id, mark));
        if (err) throw new Error(err);
        if (p.closedAt !== null) {
          const tErr = await upsertTradeRow(sb, closedToTradeRow(p, acc.id, user.id, mark));
          if (tErr) throw new Error(tErr);
          lastExitRef.current.set(p.id, mark);
        }
      }
      // Verify before marking migrated (prevents duplicate re-imports).
      const [{ rows: posRows }, { rows: tradeRows }] = await Promise.all([
        fetchPositions(sb, acc.id),
        fetchTrades(sb, acc.id),
      ]);
      const closedLocal = snap.positions.filter((p) => p.closedAt !== null).length;
      if (posRows.length < snap.positions.length || tradeRows.length < closedLocal) {
        throw new Error(`Verification failed: cloud has ${posRows.length} positions / ${tradeRows.length} trades. Local data preserved — retry import.`);
      }
      try {
        localStorage?.setItem(MIGRATION_FLAG(user.id), "1");
      } catch { /* ignore */ }
      setNeedsMigration(false);
      setMigrated(true);
      lastPushedSig.current = sigOf(engine.getSnapshot());
      setStatus("synced");
      setLastSyncedAt(Date.now());
      return true;
    } catch (e) {
      setLastError(e instanceof Error ? e.message : "Import failed. Local data preserved.");
      setStatus("error");
      return false;
    }
  }, [engine, marks, user]);

  const retry = useCallback(() => setNonce((n) => n + 1), []);

  const value = useMemo<PaperCloudSync>(
    () => ({ status, account, hydrated, needsMigration, migrated, lastError, lastSyncedAt, migrate, retry }),
    [status, account, hydrated, needsMigration, migrated, lastError, lastSyncedAt, migrate, retry],
  );
  return value;
}

function sigOf(snap: PaperSnapshot): string {
  // Cheap change signature: balance + stats + per-position id/status/closedAt.
  const parts = [
    snap.balance,
    snap.realizedPnl,
    snap.feesPaid,
    snap.closedCount,
    snap.wins,
    snap.positions.length,
    ...snap.positions.map((p) => `${p.id}:${p.status}:${p.closedAt ?? 0}:${p.realized}:${p.fees}`),
  ];
  return parts.join("|");
}
