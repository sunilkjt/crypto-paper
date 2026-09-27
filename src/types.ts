export type Direction = "LONG" | "SHORT" | "WAIT";

export interface PlaceholderSignal {
  coin: string;
  direction: Direction;
  entry: string;
  sl: string;
  tp1: string;
  tp2: string;
  strength: string;
}

export interface NavItem {
  to: string;
  label: string;
  iconName:
    | "dashboard"
    | "scanner"
    | "coin"
    | "bounce"
    | "history"
    | "backtest"
    | "paper"
    | "settings";
}

export const APP_NAME = "CryptoIn AI Signal";
export const PHASE_LABEL = "Phase 1 · Foundation";
export const DEMO_NOTICE =
  "Demo / placeholder — live Hyperliquid data connects in Phase 2.";
