/**
 * Alert-ready notification bus (in-app only — no Telegram in this phase).
 * The scan engine emits events; UI subscribes. Events fire on material
 * changes only: NEW high-confluence setups (strength ≥ 75) and noteworthy
 * lifecycle transitions. Never one alert per refresh.
 */

export type NotificationKind = "NEW_SETUP" | "STATE_CHANGE";

export interface SignalNotification {
  id: string;
  kind: NotificationKind;
  symbol: string;
  direction: "LONG" | "SHORT";
  strength: number;
  message: string;
  at: number;
  read: boolean;
}

type Listener = (events: SignalNotification[]) => void;

const listeners = new Set<Listener>();
let feed: SignalNotification[] = [];
let seq = 0;

const MAX_FEED = 50;

export function emitNotification(n: Omit<SignalNotification, "id" | "at" | "read">): SignalNotification {
  const full: SignalNotification = {
    ...n,
    id: `n${Date.now()}-${seq++}`,
    at: Date.now(),
    read: false,
  };
  feed = [full, ...feed].slice(0, MAX_FEED);
  for (const l of listeners) {
    try {
      l(feed);
    } catch {
      // listener errors must not break the engine
    }
  }
  return full;
}

export function subscribeNotifications(listener: Listener): () => void {
  listeners.add(listener);
  listener(feed);
  return () => {
    listeners.delete(listener);
  };
}

export function markAllNotificationsRead(): void {
  feed = feed.map((n) => ({ ...n, read: true }));
  for (const l of listeners) {
    try {
      l(feed);
    } catch {
      // ignore
    }
  }
}

export function unreadCount(events: SignalNotification[]): number {
  return events.filter((n) => !n.read).length;
}

export function resetNotificationsForTests(): void {
  feed = [];
  listeners.clear();
  seq = 0;
}
