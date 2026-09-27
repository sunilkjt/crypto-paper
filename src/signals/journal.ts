import type { Outcome } from "./outcomes";
import type { SignalLifecycleState } from "./lifecycle";
import type { SetupType } from "./setupType";
import type { SignalQuality } from "./quality";

/** Journal lifecycle adds EXPIRED (max lifetime or decayed structure). */
export type JournalStatus = SignalLifecycleState | "EXPIRED";

/**
 * Signal journal: localStorage-backed history of every recorded setup.
 * Upserts dedupe by stable signal ID; lifecycle states and outcomes are
 * refreshed by later scans. Nothing leaves the browser.
 */

export interface JournalEntry {
  id: string;
  symbol: string;
  firstSeen: number;
  lastSeen: number;
  direction: "LONG" | "SHORT";
  setupType: SetupType;
  timeframe: string;
  entryLow: number | null;
  entryHigh: number | null;
  invalidation: number | null;
  tp1: number | null;
  tp2: number | null;
  tp3: number | null;
  riskReward: number | null;
  strength: number;
  quality: SignalQuality;
  status: JournalStatus;
  outcome: Outcome | null;
  /** Lazily backfilled when the coin AI explanation runs. */
  aiSummary: string | null;
  /** Headlines observed at record time (usually empty). */
  newsHeadlines: string[];
  dataTimestamp: number;
}

const JOURNAL_KEY = "cryptoin:signal-journal:v1";
const MAX_ENTRIES = 300;

function storage(): Storage | null {
  if (overrideForTests) return overrideForTests;
  try {
    if (typeof localStorage !== "undefined") return localStorage;
  } catch {
    // ignore
  }
  return null;
}

let overrideForTests: Storage | null = null;

/** Test seam: inject an in-memory Storage-like object. */
export function __setJournalStorageForTests(s: Storage | null): void {
  overrideForTests = s;
}

export function loadJournal(): JournalEntry[] {
  const s = storage();
  if (!s) return [];
  try {
    const raw = s.getItem(JOURNAL_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is JournalEntry =>
        typeof e === "object" &&
        e !== null &&
        typeof (e as JournalEntry).id === "string" &&
        typeof (e as JournalEntry).symbol === "string",
    );
  } catch {
    return [];
  }
}

function saveJournal(entries: JournalEntry[]): void {
  const s = storage();
  if (!s) return;
  try {
    const trimmed = [...entries]
      .sort((a, b) => b.lastSeen - a.lastSeen)
      .slice(0, MAX_ENTRIES);
    s.setItem(JOURNAL_KEY, JSON.stringify(trimmed));
  } catch {
    // quota / private mode — journaling is best-effort
  }
}

export interface JournalUpsert {
  id: string;
  symbol: string;
  direction: "LONG" | "SHORT";
  setupType: SetupType;
  timeframe: string;
  entryLow: number | null;
  entryHigh: number | null;
  invalidation: number | null;
  tp1: number | null;
  tp2: number | null;
  tp3: number | null;
  riskReward: number | null;
  strength: number;
  quality: SignalQuality;
  status: JournalStatus;
  outcome: Outcome | null;
  newsHeadlines: string[];
  dataTimestamp: number;
  now?: number;
}

/** Insert or refresh one signal; returns the stored entry. */
export function upsertJournalSignal(u: JournalUpsert): JournalEntry {
  const now = u.now ?? Date.now();
  const entries = loadJournal();
  const idx = entries.findIndex((e) => e.id === u.id);
  if (idx === -1) {
    const entry: JournalEntry = {
      id: u.id,
      symbol: u.symbol,
      firstSeen: now,
      lastSeen: now,
      direction: u.direction,
      setupType: u.setupType,
      timeframe: u.timeframe,
      entryLow: u.entryLow,
      entryHigh: u.entryHigh,
      invalidation: u.invalidation,
      tp1: u.tp1,
      tp2: u.tp2,
      tp3: u.tp3,
      riskReward: u.riskReward,
      strength: u.strength,
      quality: u.quality,
      status: u.status,
      outcome: u.outcome,
      aiSummary: null,
      newsHeadlines: u.newsHeadlines,
      dataTimestamp: u.dataTimestamp,
    };
    entries.push(entry);
    saveJournal(entries);
    return entry;
  }
  const prev = entries[idx];
  const next: JournalEntry = {
    ...prev,
    lastSeen: now,
    strength: u.strength,
    quality: u.quality,
    status: u.status,
    outcome: u.outcome ?? prev.outcome,
    entryLow: u.entryLow ?? prev.entryLow,
    entryHigh: u.entryHigh ?? prev.entryHigh,
    invalidation: u.invalidation ?? prev.invalidation,
    tp1: u.tp1 ?? prev.tp1,
    tp2: u.tp2 ?? prev.tp2,
    tp3: u.tp3 ?? prev.tp3,
    riskReward: u.riskReward ?? prev.riskReward,
    newsHeadlines: u.newsHeadlines.length > 0 ? u.newsHeadlines : prev.newsHeadlines,
    dataTimestamp: u.dataTimestamp,
  };
  entries[idx] = next;
  saveJournal(entries);
  return next;
}

/** Backfill the AI summary when a coin explanation runs (lazy, on demand). */
export function backfillAiSummary(symbol: string, direction: "LONG" | "SHORT", summary: string): void {
  const entries = loadJournal();
  let changed = false;
  for (const e of entries) {
    if (e.symbol === symbol && e.direction === direction && e.aiSummary === null) {
      e.aiSummary = summary.slice(0, 600);
      changed = true;
    }
  }
  if (changed) saveJournal(entries);
}

export function clearJournal(): void {
  try {
    storage()?.removeItem(JOURNAL_KEY);
  } catch {
    // ignore
  }
}
