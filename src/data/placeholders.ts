import type { PlaceholderSignal } from "../types";

export const SCANNER_COLUMNS = [
  "Coin",
  "Price",
  "24h",
  "Volume",
  "Funding",
  "OI",
  "Trend",
  "RSI",
  "Signal",
  "Strength",
] as const;

export const HISTORY_COLUMNS = [
  "Date",
  "Coin",
  "Direction",
  "Entry",
  "SL",
  "TP1",
  "TP2",
  "Result",
  "PnL",
  "Signal Strength",
] as const;

export const RECENT_SIGNAL_COLUMNS = [
  "Time",
  "Coin",
  "Direction",
  "Entry",
  "SL",
  "TP",
  "Strength",
  "Status",
] as const;

export const TOP_PLACEHOLDER_SIGNALS: PlaceholderSignal[] = [
  { coin: "OP", direction: "LONG", entry: "—", sl: "—", tp1: "—", tp2: "—", strength: "—" },
  { coin: "BTC", direction: "WAIT", entry: "—", sl: "—", tp1: "—", tp2: "—", strength: "—" },
  { coin: "ETH", direction: "WAIT", entry: "—", sl: "—", tp1: "—", tp2: "—", strength: "—" },
];

export const COIN_WATCHLIST = ["BTC", "ETH", "SOL", "OP", "ARB", "AVAX", "LINK", "DOGE"];

export const TIMEFRAMES = ["1m", "5m", "15m", "1h", "4h"] as const;

export const BACKTEST_METRICS = [
  "Total Trades",
  "Win Rate",
  "Average R",
  "Profit Factor",
  "Max Drawdown",
  "TP1 Hit Rate",
  "TP2 Hit Rate",
  "TP3 Hit Rate",
] as const;
