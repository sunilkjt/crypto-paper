/**
 * Alert filter settings. Persisted; edited on #/settings.
 * minStrength gates entry, directions/setups/timeframes scope it,
 * watchlistOnly restricts to watched coins.
 */

export interface AlertSettings {
  minStrength: 60 | 70 | 80 | 90;
  directions: ("LONG" | "SHORT")[];
  setups: ("BOUNCE" | "BREAKOUT" | "PULLBACK" | "REVERSAL" | "ALL")[];
  timeframes: ("5m" | "15m" | "1h" | "4h")[];
  browserNotifications: boolean;
  soundAlerts: boolean;
  watchlistOnly: boolean;
}

export const DEFAULT_ALERT_SETTINGS: AlertSettings = {
  minStrength: 70,
  directions: ["LONG", "SHORT"],
  setups: ["ALL"],
  timeframes: ["5m", "15m", "1h", "4h"],
  browserNotifications: false,
  soundAlerts: false,
  watchlistOnly: false,
};

const SETTINGS_KEY = "cryptoin:alert-settings:v1";

function storage(): Storage | null {
  try {
    if (typeof localStorage !== "undefined") return localStorage;
  } catch {
    // ignore
  }
  return null;
}

export function loadAlertSettings(): AlertSettings {
  const s = storage();
  if (!s) return { ...DEFAULT_ALERT_SETTINGS };
  try {
    const raw = s.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_ALERT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<AlertSettings>;
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
    };
  } catch {
    return { ...DEFAULT_ALERT_SETTINGS };
  }
}

export function saveAlertSettings(settings: AlertSettings): void {
  try {
    storage()?.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // best effort
  }
}

/** Pure gate: does this candidate pass the user's filters? */
export function passesAlertFilters(
  candidate: { strength: number; direction: "LONG" | "SHORT"; setupType: string; timeframe: string; watched: boolean },
  settings: AlertSettings,
): boolean {
  if (candidate.strength < settings.minStrength) return false;
  if (!settings.directions.includes(candidate.direction)) return false;
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
