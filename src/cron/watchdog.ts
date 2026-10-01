/**
 * Independent watchdog for the 24/7 signal cron. Reads the scanner
 * heartbeat — never writes scanner state, never scans, never calls AI.
 * A stale heartbeat triggers exactly one Telegram alert; recovery triggers
 * exactly one recovery message. Alert state persists separately from scanner
 * data so a watchdog failure can never corrupt it.
 */

export interface WatchdogHeartbeat {
  lastRunAt: number | null;
  perCategory: Record<string, { universe: number; scanned: number; signals: number }>;
  lastDeliveryAt: number | null;
}

export interface WatchdogAlertState {
  alertedAt: number | null;
}

export type WatchdogDecision =
  | { action: "none" }
  | { action: "alert"; message: string }
  | { action: "recover"; message: string; outageMs: number };

export function formatAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "<1 min";
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function fmtTime(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "—";
  return `${new Date(ms).toISOString().slice(11, 16)} UTC`;
}

function categoryLines(perCategory: Record<string, { universe: number; scanned: number; signals: number }>): string[] {
  const label = (k: string) => (k === "crypto" ? "Crypto" : k === "stocks" ? "Stocks" : k === "commodities" ? "Commodities" : k);
  return Object.entries(perCategory).map(
    ([k, c]) => `${label(k)}: ${c.universe} markets · ${c.scanned} scanned · ${c.signals} signals`,
  );
}

function alertMessage(hb: WatchdogHeartbeat | null, now: number): string {
  const lines = ["⚠️ Signal Scanner Stale", ""];
  if (!hb || hb.lastRunAt === null) {
    lines.push("Last successful scan: never (no heartbeat recorded yet)");
    lines.push(`Age: ${hb ? formatAge(now - (hb.lastRunAt ?? now)) : "—"}`);
  } else {
    lines.push(`Last successful scan: ${fmtTime(hb.lastRunAt)}`);
    lines.push(`Age: ${formatAge(now - hb.lastRunAt)}`);
  }
  lines.push("");
  lines.push("Last known status:");
  const cats = hb ? categoryLines(hb.perCategory) : [];
  if (cats.length === 0) lines.push("no category data yet");
  else lines.push(...cats);
  return lines.join("\n");
}

function recoverMessage(alertedAt: number, now: number): string {
  return [
    "✅ Signal Scanner Recovered",
    "",
    "Scanner is running normally again.",
    `Recovered at: ${fmtTime(now)}`,
    `Previous outage duration: ${formatAge(now - alertedAt)}`,
  ].join("\n");
}

export function evaluateWatchdog(opts: {
  heartbeat: WatchdogHeartbeat | null;
  alertedAt: number | null;
  now: number;
  staleAfterMs: number;
}): WatchdogDecision {
  const { heartbeat, alertedAt, now, staleAfterMs } = opts;
  const stale =
    heartbeat === null ||
    heartbeat.lastRunAt === null ||
    !Number.isFinite(heartbeat.lastRunAt) ||
    now - heartbeat.lastRunAt > staleAfterMs;
  if (stale) {
    if (alertedAt !== null) return { action: "none" };
    return { action: "alert", message: alertMessage(heartbeat, now) };
  }
  if (alertedAt !== null) {
    return { action: "recover", message: recoverMessage(alertedAt, now), outageMs: now - alertedAt };
  }
  return { action: "none" };
}

export interface WatchdogDeps {
  now: number;
  staleAfterMs: number;
  loadHeartbeat: () => Promise<WatchdogHeartbeat | null>;
  loadAlertState: () => Promise<WatchdogAlertState>;
  saveAlertState: (state: WatchdogAlertState) => Promise<void>;
  /** Returns true when at least the alert attempt completed. */
  deliverAlert: (text: string) => Promise<boolean>;
  log?: (msg: string) => void;
}

export interface WatchdogReport {
  action: "none" | "alert" | "recover";
  alerted: boolean;
  errors: string[];
}

/**
 * One watchdog pass. Delivery failure never mutates alert state, so the
 * next pass retries instead of losing the outage (recoverable by design).
 * Overlapping passes converge: the second sees persisted alert state.
 */
export async function checkOnce(deps: WatchdogDeps): Promise<WatchdogReport> {
  const log = deps.log ?? (() => {});
  let heartbeat: WatchdogHeartbeat | null = null;
  try {
    heartbeat = await deps.loadHeartbeat();
  } catch (e) {
    log(`watchdog: heartbeat read failed (${e instanceof Error ? e.message : "unknown"}) — treating as stale`);
    heartbeat = null;
  }
  let alertedAt: number | null = null;
  try {
    alertedAt = (await deps.loadAlertState()).alertedAt;
  } catch (e) {
    log(`watchdog: alert-state read failed (${e instanceof Error ? e.message : "unknown"})`);
    alertedAt = null;
  }

  const decision = evaluateWatchdog({
    heartbeat,
    alertedAt,
    now: deps.now,
    staleAfterMs: deps.staleAfterMs,
  });
  if (decision.action === "none") {
    return { action: "none", alerted: false, errors: [] };
  }
  let ok = false;
  try {
    ok = await deps.deliverAlert(decision.message);
  } catch (e) {
    log(`watchdog: delivery failed (${e instanceof Error ? e.message : "unknown"})`);
    ok = false;
  }
  if (!ok) {
    return { action: decision.action, alerted: false, errors: ["delivery failed; alert state untouched, will retry"] };
  }
  try {
    await deps.saveAlertState(
      decision.action === "alert" ? { alertedAt: deps.now } : { alertedAt: null },
    );
  } catch (e) {
    return { action: decision.action, alerted: true, errors: [`alert-state save failed (${e instanceof Error ? e.message : "unknown"})`] };
  }
  log(`watchdog: ${decision.action} recorded`);
  return { action: decision.action, alerted: true, errors: [] };
}
