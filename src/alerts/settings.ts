/**
 * Alert filter settings. Persisted; edited on #/settings.
 * minStrength gates entry, directions/setups/timeframes scope it,
 * watchlistOnly restricts to watched coins, categories scope delivery to
 * market classes, cooldownMs suppresses repeat facts (delivery only —
 * history always records). Settings never modify signals themselves.
 */

export type CooldownOption = 0 | 900_000 | 1_800_000 | 3_600_000;

export interface AlertSettings {
  minStrength: 60 | 70 | 80 | 90;
  directions: ("LONG" | "SHORT")[];
  setups: ("BOUNCE" | "BREAKOUT" | "PULLBACK" | "REVERSAL" | "ALL")[];
  timeframes: ("5m" | "15m" | "1h" | "4h")[];
  browserNotifications: boolean;
  soundAlerts: boolean;
  watchlistOnly: boolean;
  /** Master switch for Telegram delivery (endpoint + connection still required). */
  telegramNotifications: boolean;
  inAppNotifications: boolean;
  categories: { crypto: boolean; stocks: boolean; commodities: boolean };
  /** Duplicate-fact suppression window (0 = off). Default 30 minutes. */
  cooldownMs: CooldownOption;
}

export const DEFAULT_ALERT_SETTINGS: AlertSettings = {
  minStrength: 70,
  directions: ["LONG", "SHORT"],
  setups: ["ALL"],
  timeframes: ["5m", "15m", "1h", "4h"],
  browserNotifications: false,
  soundAlerts: false,
  watchlistOnly: false,
  telegramNotifications: false,
  inAppNotifications: true,
  categories: { crypto: true, stocks: true, commodities: true },
  cooldownMs: 1_800_000,
};

export const COOLDOWN_OPTIONS: { value: CooldownOption; label: string }[] = [
  { value: 0, label: "Off" },
  { value: 900_000, label: "15 min" },
  { value: 1_800_000, label: "30 min" },
  { value: 3_600_000, label: "60 min" },
];

const SETTINGS_KEY = "cryptoin:alert-settings:v1";

let overrideForTests: Storage | null | undefined;

function storage(): Storage | null {
  if (overrideForTests !== undefined) return overrideForTests;
  try {
    if (typeof localStorage !== "undefined") return localStorage;
  } catch {
    // ignore
  }
  return null;
}

/** Test seam: inject an in-memory Storage-like object. */
export function __setAlertSettingsStorageForTests(s: Storage | null): void {
  overrideForTests = s;
}

export function loadAlertSettings(): AlertSettings {
  const s = storage();
  if (!s) return { ...DEFAULT_ALERT_SETTINGS };
  try {
    const raw = s.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_ALERT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<AlertSettings>;
    const cats = parsed.categories;
    return {
      minStrength: [60, 70, 80, 90].includes(parsed.minStrength as number)
        ? (parsed.minStrength as AlertSettings["minStrength"])
        : DEFAULT_ALERT_SETTINGS.minStrength,
      directions: Array.isArray(parsed.directions) && parsed.directions.length > 0
        ? parsed.directions.filter((d) => d === "LONG" || d === "SHORT") as ("LONG" | "SHORT")[]
        : ["LONG", "SHORT"],
      setups: Array.isArray(parsed.setups) && parsed.setups.length > 0 ? parsed.setups as AlertSettings["setups"] : ["ALL"],
      timeframes: Array.isArray(parsed.timeframes) && parsed.timeframes.length > 0 ? parsed.timeframes as AlertSettings["timeframes"] : ["5m", "15m", "1h", "4h"],
      browserNotifications: parsed.browserNotifications === true,
      soundAlerts: parsed.soundAlerts === true,
      watchlistOnly: parsed.watchlistOnly === true,
      telegramNotifications: parsed.telegramNotifications === true,
      inAppNotifications: parsed.inAppNotifications !== false,
      categories:
        cats && typeof cats === "object"
          ? {
              crypto: cats.crypto !== false,
              stocks: cats.stocks !== false,
              commodities: cats.commodities !== false,
            }
          : { ...DEFAULT_ALERT_SETTINGS.categories },
      cooldownMs: ([0, 900_000, 1_800_000, 3_600_000] as number[]).includes(parsed.cooldownMs as number)
        ? (parsed.cooldownMs as AlertSettings["cooldownMs"])
        : DEFAULT_ALERT_SETTINGS.cooldownMs,
    };
  } catch {
    return { ...DEFAULT_ALERT_SETTINGS };
  }
}

const settingListeners = new Set<() => void>();

/** Subscribe to settings changes (e.g. the topbar bell visibility). */
export function subscribeAlertSettings(listener: () => void): () => void {
  settingListeners.add(listener);
  return () => {
    settingListeners.delete(listener);
  };
}

export function saveAlertSettings(settings: AlertSettings): void {
  try {
    storage()?.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // best effort
  }
  for (const l of settingListeners) {
    try {
      l();
    } catch {
      // ignore listener errors
    }
  }
}

/** Pure gate: does this candidate pass the user's filters? */
export function passesAlertFilters(
  candidate: {
    strength: number;
    direction: "LONG" | "SHORT";
    setupType: string;
    timeframe: string;
    watched: boolean;
    /** Market class; undefined (legacy callers) passes — never restrict blindly. */
    category?: "crypto" | "stocks" | "commodities" | "other";
  },
  settings: AlertSettings,
): boolean {
  if (candidate.strength < settings.minStrength) return false;
  if (!settings.directions.includes(candidate.direction)) return false;
  if (candidate.category === "stocks" && !settings.categories.stocks) return false;
  if (candidate.category === "commodities" && !settings.categories.commodities) return false;
  if (candidate.category === "crypto" && !settings.categories.crypto) return false;
  if (!settings.setups.includes("ALL")) {
    const want = settings.setups.map((s) => {
      if (s === "BOUNCE") return "BOUNCE";
      if (s === "BREAKOUT") return ["BREAKOUT", "BREAKDOWN"];
      if (s === "PULLBACK") return "PULLBACK";
      return "REVERSAL";
    }).flat();
    if (!want.includes(candidate.setupType)) return false;
  }
  if (!settings.timeframes.includes(candidate.timeframe as AlertSettings["timeframes"][number])) return false;
  if (settings.watchlistOnly && !candidate.watched) return false;
  return true;
}
