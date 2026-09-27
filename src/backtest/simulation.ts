import type { Candle, Timeframe } from "../market/hyperliquid/types";
import { buildSignal } from "../analysis/signal";
import { classifySetupType } from "../signals/setupType";
import { timeframeToMs } from "../market/hyperliquid/timeframes";
import type {
  BacktestConfig,
  BacktestTrade,
  TradeResult,
} from "./types";

/**
 * Trade simulation on replayed candles. Entry fills at the NEXT bar open
 * after the signal (plus slippage) — never at the signal close.
 * Same-candle TP/SL conflict resolves conservatively: the STOP wins.
 * Exits scale out in thirds at TP1/TP2/TP3; remainder stops or expires.
 */

export interface SimProgress {
  bar: number;
  bars: number;
  trades: number;
}

export interface SimulateArgs {
  symbol: string;
  setupTimeframe: Timeframe;
  candles: Candle[];
  fundingSamples: { timestamp: number; rate: number }[];
  config: BacktestConfig;
  balance: number;
  inSample: (timestamp: number) => boolean;
  onProgress?: (p: SimProgress) => void;
  shouldYield?: (bar: number) => boolean;
}

export interface SimulateOutput {
  trades: BacktestTrade[];
  endBalance: number;
}

/** Resample candles up to a coarser timeframe (pure aggregation, no future). */
export function resampleCandles(candles: Candle[], timeframe: Timeframe): Candle[] {
  const ms = timeframeToMs(timeframe);
  const out: Candle[] = [];
  let cur: Candle | null = null;
  let bucket = -1;
  for (const c of candles) {
    const b = Math.floor(c.timestamp / ms);
    if (b !== bucket) {
      if (cur) out.push(cur);
      bucket = b;
      cur = { timestamp: b * ms, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume };
    } else if (cur) {
      cur.high = Math.max(cur.high, c.high);
      cur.low = Math.min(cur.low, c.low);
      cur.close = c.close;
      cur.volume += c.volume;
    }
  }
  if (cur) out.push(cur);
  return out;
}

const SETUP_ORDER: Timeframe[] = ["5m", "15m", "1h", "4h"];

function higherTimeframes(tf: Timeframe): Timeframe[] {
  return SETUP_ORDER.filter((t) => timeframeToMs(t) > timeframeToMs(tf));
}

export async function simulateRange(args: SimulateArgs): Promise<SimulateOutput> {
  const { symbol, setupTimeframe, candles, fundingSamples, config, onProgress, shouldYield } = args;
  let balance = args.balance;
  const trades: BacktestTrade[] = [];
  const WINDOW = 400; // trailing window per signal: indicator stability, strictly prefix
  const MIN_HISTORY = 211;
  let open: OpenPosition | null = null;
  let tradeIndex = 0;

  for (let i = 0; i < candles.length; i++) {
    if (shouldYield?.(i)) await new Promise((r) => setTimeout(r, 0));
    if (i % 200 === 0) onProgress?.({ bar: i, bars: candles.length, trades: trades.length });

    // Manage the open position on this bar's range FIRST (fills from past decisions).
    if (open) {
      const done = manageOpen(open, candles[i], config, fundingSamples);
      if (done) {
        balance = applyClose(balance, open, done, config);
        trades.push(finalizeTrade(open, done, tradeIndex++, symbol, setupTimeframe, args.inSample));
        open = null;
      }
      continue; // one position at a time; skip new entries while open
    }

    // New signal: strictly historical prefix, trailing window (no look-ahead).
    if (i + 1 < MIN_HISTORY) continue;
    const prefix = candles.slice(Math.max(0, i + 1 - WINDOW), i + 1);
    if (prefix.length < MIN_HISTORY) continue;
    const byTf: Partial<Record<Timeframe, Candle[]>> = { [setupTimeframe]: prefix };
    for (const tf of higherTimeframes(setupTimeframe)) {
      const resampled = resampleCandles(prefix, tf);
      if (resampled.length >= 60) byTf[tf] = resampled;
    }
    // Finer TFs are unavailable from coarser history — engine renormalizes with a warning.
    const { signal } = buildSignal({ symbol, setupTimeframe, candlesByTf: byTf });
    if (signal.direction === "WAIT" || signal.signalStrength < config.minStrength) continue;
    if (signal.entryLow === null || signal.entryHigh === null || signal.invalidation === null) continue;

    // Fill at the NEXT bar open (or skip if at the data edge).
    const fillBar = candles[i + 1];
    if (!fillBar) continue;
    open = openPosition(prefix[prefix.length - 1], fillBar, signal, config, balance);
    if (!open) continue;
  }

  // Expire any open remainder at the final close.
  if (open) {
    const last = candles[candles.length - 1];
    const done = forceClose(open, last, config);
    balance = applyClose(balance, open, done, config);
    trades.push(finalizeTrade(open, done, tradeIndex++, symbol, setupTimeframe, args.inSample));
  }

  onProgress?.({ bar: candles.length, bars: candles.length, trades: trades.length });
  return { trades, endBalance: balance };
}

interface OpenPosition {
  direction: "LONG" | "SHORT";
  entry: number;
  size: number;
  notional: number;
  margin: number;
  risk: number;
  invalidation: number;
  tp1: number;
  tp2: number;
  tp3: number;
  entryTimestamp: number;
  signalTimestamp: number;
  strength: number;
  classification: string;
  setupType: string;
  thirdsRemaining: number;
  realized: number;
  fees: number;
  /** Best/worst price excursion from entry (converted to R at finalize). */
  mfePrice: number;
  maePrice: number;
  hitTp1: boolean;
  hitTp2: boolean;
  hitTp3: boolean;
  hitStop: boolean;
}

interface CloseInfo {
  exitTimestamp: number;
  result: TradeResult;
}

function slip(price: number, direction: "LONG" | "SHORT", side: "entry" | "exit", rate: number): number {
  const worsen = direction === "LONG" ? (side === "entry" ? 1 : -1) : side === "entry" ? -1 : 1;
  return price * (1 + worsen * rate);
}

function openPosition(
  signalBar: Candle,
  fillBar: Candle,
  signal: ReturnType<typeof buildSignal>["signal"],
  config: BacktestConfig,
  balance: number,
): OpenPosition | null {
  if (signal.direction !== "LONG" && signal.direction !== "SHORT") return null;
  if (signal.entryLow === null || signal.entryHigh === null || signal.invalidation === null) return null;
  const entryMid = (signal.entryLow + signal.entryHigh) / 2;
  const stopDist =
    signal.direction === "LONG" ? entryMid - signal.invalidation : signal.invalidation - entryMid;
  if (!(stopDist > 0) || !(balance > 0)) return null;
  const entry = slip(fillBar.open, signal.direction, "entry", config.slippageRate);
  const risked = balance * config.riskPerTrade;
  const size = risked / stopDist;
  const notional = size * entry;
  return {
    direction: signal.direction,
    entry,
    size,
    notional,
    margin: notional / Math.max(1, config.leverage),
    risk: risked,
    invalidation: signal.invalidation,
    tp1: signal.tp1 ?? entry,
    tp2: signal.tp2 ?? entry,
    tp3: signal.tp3 ?? entry,
    entryTimestamp: fillBar.timestamp,
    signalTimestamp: signalBar.timestamp,
    strength: signal.signalStrength,
    classification: signal.classification,
    setupType: classifySetupType(signal),
    thirdsRemaining: 3,
    realized: 0,
    fees: notional * config.feeRate,
    mfePrice: 0,
    maePrice: 0,
    hitTp1: false,
    hitTp2: false,
    hitTp3: false,
    hitStop: false,
  };
}

/** Advance one bar; returns close info when the position fully exits. */
function manageOpen(
  p: OpenPosition,
  bar: Candle,
  config: BacktestConfig,
  funding: { timestamp: number; rate: number }[],
): CloseInfo | null {
  const isLong = p.direction === "LONG";
  const touch = (level: number) => (isLong ? bar.high >= level : bar.low <= level);
  const touchStop = isLong ? bar.low <= p.invalidation : bar.high >= p.invalidation;

  // Excursions in price terms (converted to R multiples at finalize).
  const fav = isLong ? bar.high - p.entry : p.entry - bar.low;
  const adv = isLong ? p.entry - bar.low : bar.high - p.entry;
  p.mfePrice = Math.max(p.mfePrice, fav);
  p.maePrice = Math.max(p.maePrice, adv);

  const third = p.size / 3;
  const exitFill = (level: number) => {
    const px = slip(level, p.direction, "exit", config.slippageRate);
    const pnl = (isLong ? px - p.entry : p.entry - px) * third;
    p.realized += pnl;
    p.fees += third * px * config.feeRate;
    p.thirdsRemaining -= 1;
  };

  // Conservative conflict rule: a bar touching BOTH stop and target
  // exits the stop first. Documented; never assumes the favorable path.
  const hitsStop = touchStop;
  const hitsTp1 = !p.hitTp1 && touch(p.tp1);
  const hitsTp2 = !p.hitTp2 && touch(p.tp2);
  const hitsTp3 = !p.hitTp3 && touch(p.tp3);

  if (hitsStop) {
    p.hitStop = true;
    // Remaining thirds all stop.
    while (p.thirdsRemaining > 0) {
      const px = slip(p.invalidation, p.direction, "exit", config.slippageRate);
      const pnl = (isLong ? px - p.entry : p.entry - px) * third;
      p.realized += pnl;
      p.fees += third * px * config.feeRate;
      p.thirdsRemaining -= 1;
    }
    applyFunding(p, bar.timestamp, funding);
    return { exitTimestamp: bar.timestamp, result: "STOPPED" };
  }
  if (hitsTp1) {
    p.hitTp1 = true;
    exitFill(p.tp1);
  }
  if (hitsTp2 && p.thirdsRemaining > 0) {
    p.hitTp2 = true;
    exitFill(p.tp2);
  }
  if (hitsTp3 && p.thirdsRemaining > 0) {
    p.hitTp3 = true;
    exitFill(p.tp3);
  }
  applyFunding(p, bar.timestamp, funding);
  if (p.thirdsRemaining <= 0) {
    const result: TradeResult = p.hitTp3 ? "TP3" : p.hitTp2 ? "TP2" : "TP1";
    return { exitTimestamp: bar.timestamp, result };
  }
  return null;
}

function applyFunding(
  p: OpenPosition,
  upToTimestamp: number,
  funding: { timestamp: number; rate: number }[],
): void {
  // Funding samples with timestamp in (lastApplied, bar]; track cursor on position.
  const cursor = (p as { _fundingCursor?: number })._fundingCursor ?? p.entryTimestamp;
  let paid = 0;
  for (const s of funding) {
    if (s.timestamp > cursor && s.timestamp <= upToTimestamp) {
      paid += p.notional * s.rate * (p.direction === "LONG" ? 1 : -1);
    }
  }
  (p as { _fundingCursor?: number })._fundingCursor = upToTimestamp;
  (p as { _fundingPaid?: number })._fundingPaid = ((p as { _fundingPaid?: number })._fundingPaid ?? 0) + paid;
}

function forceClose(p: OpenPosition, last: Candle, config: BacktestConfig): CloseInfo {
  const isLong = p.direction === "LONG";
  while (p.thirdsRemaining > 0) {
    const px = slip(last.close, p.direction, "exit", config.slippageRate);
    const third = p.size / 3;
    p.realized += (isLong ? px - p.entry : p.entry - px) * third;
    p.fees += third * px * config.feeRate;
    p.thirdsRemaining -= 1;
  }
  void config;
  return { exitTimestamp: last.timestamp, result: "EXPIRED" };
}

function applyClose(balance: number, p: OpenPosition, _done: CloseInfo, config: BacktestConfig): number {
  void config;
  const fundingPaid = (p as { _fundingPaid?: number })._fundingPaid ?? 0;
  return balance + p.realized - p.fees - fundingPaid;
}

function finalizeTrade(
  p: OpenPosition,
  done: CloseInfo,
  index: number,
  symbol: string,
  timeframe: Timeframe,
  inSample: (timestamp: number) => boolean,
): BacktestTrade {
  const fundingPaid = (p as { _fundingPaid?: number })._fundingPaid ?? 0;
  const pnl = p.realized - p.fees - fundingPaid;
  const rMultiple = p.risk > 0 ? pnl / p.risk : 0;
  const stopDist = p.size > 0 ? p.risk / p.size : 0;
  return {
    index,
    symbol,
    timeframe,
    signalTimestamp: p.signalTimestamp,
    direction: p.direction,
    setupType: p.setupType as BacktestTrade["setupType"],
    strength: p.strength,
    classification: p.classification as BacktestTrade["classification"],
    entry: p.entry,
    invalidation: p.invalidation,
    tp1: p.tp1,
    tp2: p.tp2,
    tp3: p.tp3,
    exit: p.direction === "LONG" ? p.entry + pnl / Math.max(p.size, 1e-12) : p.entry - pnl / Math.max(p.size, 1e-12),
    result: done.result,
    rMultiple: Math.round(rMultiple * 100) / 100,
    pnl: Math.round(pnl * 100) / 100,
    fees: Math.round(p.fees * 100) / 100,
    fundingPaid: Math.round(fundingPaid * 100) / 100,
    positionSize: p.size,
    notional: p.notional,
    margin: p.margin,
    entryTimestamp: p.entryTimestamp,
    exitTimestamp: done.exitTimestamp,
    durationMs: done.exitTimestamp - p.entryTimestamp,
    maxFavorableR: stopDist > 0 ? Math.round((p.mfePrice / stopDist) * 100) / 100 : 0,
    maxAdverseR: stopDist > 0 ? -Math.round((p.maePrice / stopDist) * 100) / 100 : 0,
    inSample: inSample(p.signalTimestamp),
  };
}
