import type { Candle } from "../market/hyperliquid/types";
import type { Timeframe } from "../market/hyperliquid/types";
import { lastEma } from "../indicators/ema";
import { rsiSeries } from "../indicators/rsi";
import { macdSeries } from "../indicators/macd";
import { lastAtr } from "../indicators/atr";
import { volumeStats } from "../indicators/volume";
import { classifyTrend, type TrendLabel } from "./trend";
import {
  classifyMomentum,
  crossedDown,
  crossedUp,
  isFalling,
  isRising,
  type MomentumLabel,
} from "./momentum";
import { classifyVolume, type VolumeLabel } from "./volumeProfile";
import { detectSwings } from "./swings";
import { buildLevels } from "./levels";
import { classifyStructure, efficiencyRatio, CHOP_ER_THRESHOLD, type StructureLabel } from "./structure";
import { analyzeMtf, type MtfResult, type TfTrendInput } from "./mtf";
import { detectBounce, type BounceResult } from "./bounce";
import {
  calculateSignalScore,
  type Direction,
  type ScoreComponents,
  type StrengthClass,
} from "./scoring";
import { buildTradePlan } from "./tradeplan";
import { timeframeToMs } from "../market/hyperliquid/timeframes";
import { MAX_EXTENSION_ATR, MAX_RISK_ATR, MIN_RISK_REWARD } from "../signals/quality";

/**
 * Unified signal object — the single shape the UI consumes.
 * INSUFFICIENT DATA (too few candles for EMA200 etc.) yields status
 * INSUFFICIENT_DATA with null plan fields instead of unreliable numbers.
 * Staleness is enforced by the UI layer (never mint fresh signals from
 * stale snapshots); dataTimestamp records what the signal was built on.
 */

export interface Signal {
  symbol: string;
  /** Close time of the last CLOSED setup candle (never wall-clock, never a forming bar). */
  timestamp: number;
  timeframe: Timeframe;
  direction: Direction;
  signalStrength: number;
  classification: StrengthClass;
  entryLow: number | null;
  entryHigh: number | null;
  /**
   * MARKET when the signal-time price sits inside the entry zone (an
   * immediately executable setup); RETEST when price must return to the
   * zone first. Null when there is no plan (WAIT).
   */
  entryType: "MARKET" | "RETEST" | null;
  /** READY (market entry) or WAIT_FOR_RETEST at generation time. */
  entryStatus: "READY" | "WAIT_FOR_RETEST" | null;
  invalidation: number | null;
  tp1: number | null;
  tp2: number | null;
  tp3: number | null;
  riskReward: number | null;
  trend: TrendLabel | "INSUFFICIENT";
  momentum: MomentumLabel | "INSUFFICIENT";
  /** Raw RSI-14 on the setup timeframe (null when unavailable). */
  rsi: number | null;
  volume: VolumeLabel | "INSUFFICIENT";
  marketStructure: StructureLabel | "INSUFFICIENT";
  /** Close-confirmed breakout state (wicks never count). */
  brokeAbove: boolean;
  brokeBelow: boolean;
  retestHeld: boolean;
  /** Stop distance in ATR multiples (null without a plan). */
  riskAtr: number | null;
  /** ATR as % of price (volatility gauge). */
  atrPct: number | null;
  /** Failed-breakout trap flag on the signal side. */
  falseBreakout: boolean;
  multiTimeframe: MtfResult | null;
  components: ScoreComponents;
  bounce: BounceResult | null;
  reasons: string[];
  warnings: string[];
  dataTimestamp: number;
  longScore: number;
  shortScore: number;
}

export type SignalStatus = "OK" | "INSUFFICIENT_DATA";

export interface BuildSignalInput {
  symbol: string;
  /** Setup timeframe (15m for scans and coin pages). */
  setupTimeframe: Timeframe;
  candlesByTf: Partial<Record<Timeframe, Candle[]>>;
}

/** Setup TF needs EMA200 (200) + indicator seeding margin. */
export const SETUP_MIN_CANDLES = 210;
/** Trend TFs need EMA200 as well when fully scored. */
export const TREND_MIN_CANDLES = 200;

export function buildSignal(input: BuildSignalInput): { status: SignalStatus; signal: Signal } {
  const { symbol, setupTimeframe } = input;
  const setup = input.candlesByTf[setupTimeframe] ?? [];
  const dataTimestamp = setup.length > 0 ? setup[setup.length - 1].timestamp : 0;

  const insufficient = (warnings: string[]): { status: SignalStatus; signal: Signal } => ({
    status: "INSUFFICIENT_DATA",
    signal: {
      symbol,
      timestamp: dataTimestamp,
      timeframe: setupTimeframe,
      direction: "WAIT",
      signalStrength: 0,
      classification: "WAIT",
      entryLow: null,
      entryHigh: null,
      entryType: null,
      entryStatus: null,
      invalidation: null,
      tp1: null,
      tp2: null,
      tp3: null,
      riskReward: null,
      trend: "INSUFFICIENT",
      momentum: "INSUFFICIENT",
      rsi: null,
      volume: "INSUFFICIENT",
      marketStructure: "INSUFFICIENT",
      brokeAbove: false,
      brokeBelow: false,
      retestHeld: false,
      riskAtr: null,
      atrPct: null,
      falseBreakout: false,
      multiTimeframe: null,
      components: { trend: 0, momentum: 0, volume: 0, structure: 0, mtf: 0 },
      bounce: null,
      reasons: [],
      warnings,
      dataTimestamp,
      longScore: 0,
      shortScore: 0,
    },
  });

  if (setup.length < SETUP_MIN_CANDLES) {
    return insufficient([
      `INSUFFICIENT DATA: ${setup.length}/${SETUP_MIN_CANDLES} ${setupTimeframe} candles — EMA200 and full indicators need more history.`,
    ]);
  }

  const closes = setup.map((c) => c.close);
  const volumes = setup.map((c) => c.volume);
  const price = closes[closes.length - 1];

  const e20 = lastEma(closes, 20);
  const e50 = lastEma(closes, 50);
  const e200 = lastEma(closes, 200);
  const rsi = rsiSeries(closes, 14);
  const rsiNow = rsi[rsi.length - 1];
  const rsiThen = rsi[rsi.length - 6] ?? null;
  const macd = macdSeries(closes);
  const hist = macd.map((m) => m.histogram);
  const histNow = hist[hist.length - 1];
  const macdLast = macd[macd.length - 1];
  const aboveSignal =
    macdLast.line !== null && macdLast.signal !== null
      ? macdLast.line > macdLast.signal
      : null;
  const atr = lastAtr(setup, 14);
  const vol = volumeStats(volumes, 20);

  const missing: string[] = [];
  if (e20 === null || e50 === null || e200 === null) missing.push("EMA20/50/200");
  if (rsiNow === null) missing.push("RSI14");
  if (histNow === null || aboveSignal === null) missing.push("MACD");
  if (atr === null) missing.push("ATR14");
  if (vol === null) missing.push("volume average");
  if (missing.length > 0) {
    return insufficient([`INSUFFICIENT DATA: unreliable ${missing.join(", ")}.`]);
  }
  // Narrow for the compiler: the guard above guarantees non-null here.
  if (
    e20 === null ||
    e50 === null ||
    e200 === null ||
    rsiNow === null ||
    histNow === null ||
    aboveSignal === null ||
    atr === null ||
    vol === null
  ) {
    return insufficient(["INSUFFICIENT DATA: classification inputs incomplete."]);
  }

  const trend = classifyTrend(price, e20, e50, e200, (atr as number) * 0.05);
  const momentum = classifyMomentum({
    rsiNow,
    rsiThen,
    crossedUp30: crossedUp(rsi, 30),
    crossedDown70: crossedDown(rsi, 70),
    histNow,
    histRising: isRising(hist, 3),
    histFalling: isFalling(hist, 3),
    aboveSignal,
  });
  const volumeP = classifyVolume(vol.relative, vol.spike);
  const swings = detectSwings(setup, 3, 120);
  const levels = buildLevels(swings, price, atr);
  const structure = classifyStructure(setup, swings, atr);
  if (!trend || !momentum || !volumeP || !structure) {
    return insufficient(["INSUFFICIENT DATA: classification inputs incomplete."]);
  }

  // Multi-timeframe assessments (setup TF included as its own slot).
  const tfInputs: Partial<Record<Timeframe, TfTrendInput>> = {};
  const tfList: Timeframe[] = ["4h", "1h", "15m", "5m"];
  for (const tf of tfList) {
    const data = tf === setupTimeframe ? setup : (input.candlesByTf[tf] ?? []);
    if (data.length < TREND_MIN_CANDLES) continue;
    const cl = data.map((c) => c.close);
    const tfAtr = lastAtr(data, 14) ?? 0;
    const t = classifyTrend(
      cl[cl.length - 1],
      lastEma(cl, 20),
      lastEma(cl, 50),
      lastEma(cl, 200),
      tfAtr * 0.05,
    );
    if (!t) continue;
    const r = rsiSeries(cl, 14);
    const m = macdSeries(cl);
    const mh = m.map((p) => p.histogram);
    tfInputs[tf] = {
      trend: t.label,
      bullPoints: t.bullPoints,
      bearPoints: t.bearPoints,
      reversalUp: crossedUp(r, 30) || isRising(mh.slice(-4).map((v) => v), 3),
      reversalDown: crossedDown(r, 70) || isFalling(mh.slice(-4).map((v) => v), 3),
    };
  }
  // Guarantee the setup TF always has an assessment (it has full history).
  if (!tfInputs[setupTimeframe]) {
    tfInputs[setupTimeframe] = {
      trend: trend.label,
      bullPoints: trend.bullPoints,
      bearPoints: trend.bearPoints,
      reversalUp: momentum.recovering,
      reversalDown: momentum.fading,
    };
  }
  const mtf = analyzeMtf(tfInputs);

  const supportDistanceAtr =
    levels.nearestSupport !== null ? (price - levels.nearestSupport.price) / (atr as number) : null;
  const resistanceDistanceAtr =
    levels.nearestResistance !== null
      ? (levels.nearestResistance.price - price) / (atr as number)
      : null;
  const bounce = detectBounce({
    price,
    atr: atr as number,
    momentum,
    structure,
    volume: volumeP,
    levels,
    mtf,
    supportDistanceAtr,
    resistanceDistanceAtr,
  });

  const scored = calculateSignalScore({
    trendLong: trend.bullPoints / 5,
    trendShort: trend.bearPoints / 5,
    momentumLong: momentum.longScore,
    momentumShort: momentum.shortScore,
    volume: volumeP.score,
    structureLong: structure.longScore,
    structureShort: structure.shortScore,
    mtfLong: mtf.longScore,
    mtfShort: mtf.shortScore,
  });

  const reasons = [...scored.reasons, ...mtf.warnings.map((w) => `MTF: ${w}`)];
  const warnings = [...scored.warnings, ...bounce.bounceWarnings];

  let direction = scored.direction;
  // Range guard: chop with flickering short-term momentum must not mint
  // directional trades. Real range-breakouts (brokeAbove/Below) still pass.
  if (
    direction !== "WAIT" &&
    structure.label === "RANGE" &&
    !structure.brokeAbove &&
    !structure.brokeBelow &&
    trend.label === "NEUTRAL"
  ) {
    direction = "WAIT";
    warnings.push("Ranging market, no breakout, neutral trend — WAIT. Never force a trade.");
  }

  // Chop-regime guard (efficiency ratio): sideways drift cannot mint
  // directional trades — unless a breakout is holding with a retest.
  const er = efficiencyRatio(closes);
  if (
    direction !== "WAIT" &&
    er !== null &&
    er < CHOP_ER_THRESHOLD &&
    !(structure.brokeAbove && structure.retestHeldAbove) &&
    !(structure.brokeBelow && structure.retestHeldBelow)
  ) {
    direction = "WAIT";
    warnings.push(
      `Choppy regime (efficiency ${er.toFixed(2)}) with no held breakout — WAIT.`,
    );
  }

  let entryLow: number | null = null;
  let entryHigh: number | null = null;
  let invalidation: number | null = null;
  let tp1: number | null = null;
  let tp2: number | null = null;
  let tp3: number | null = null;
  let riskReward: number | null = null;

  if (direction === "LONG" || direction === "SHORT") {
    // Bounce-page agreement is checked by callers; record disagreement here.
    if (bounce.direction !== null && bounce.direction !== direction) {
      warnings.push(
        `Bounce detector favors ${bounce.direction} (score ${bounce.bounceScore}) — conflicts with ${direction} confluence.`,
      );
    }
    const plan = buildTradePlan({
      direction,
      price,
      atr: atr as number,
      levels,
      structure,
    });
    if (!plan) {
      direction = "WAIT";
      warnings.push("No valid trade structure (levels/invalidation) — WAIT. Never force a trade.");
    } else {
      // Risk/reward gate: poor value, an excessive stop, or a chased entry
      // kills the setup — WAIT — POOR RISK/REWARD rather than forcing it.
      const entryMid = (plan.entryLow + plan.entryHigh) / 2;
      const stopDist =
        direction === "LONG" ? entryMid - plan.invalidation : plan.invalidation - entryMid;
      const riskAtr = stopDist / (atr as number);
      const refLevel =
        direction === "LONG"
          ? (levels.nearestSupport?.price ?? structure.lastSwingLow)
          : (levels.nearestResistance?.price ?? structure.lastSwingHigh);
      const extensionAtr =
        refLevel !== null && refLevel !== undefined
          ? Math.abs(price - refLevel) / (atr as number)
          : 0;
      if (extensionAtr > MAX_EXTENSION_ATR) {
        direction = "WAIT";
        warnings.push(
          `WAIT — POOR RISK/REWARD (chasing: price ${extensionAtr.toFixed(1)} ATR from the level).`,
        );
      } else if (plan.riskReward < MIN_RISK_REWARD || riskAtr > MAX_RISK_ATR) {
        direction = "WAIT";
        warnings.push(
          `WAIT — POOR RISK/REWARD (R:R ${plan.riskReward}, stop ${riskAtr.toFixed(1)} ATR).`,
        );
      } else {
        entryLow = plan.entryLow;
        entryHigh = plan.entryHigh;
        invalidation = plan.invalidation;
        tp1 = plan.tp1;
        tp2 = plan.tp2;
        tp3 = plan.tp3;
        riskReward = plan.riskReward;
      }
    }
  } else {
    reasons.push(...bounce.bounceReasons);
  }

  return {
    status: "OK",
    signal: {
      symbol,
      // Candle-close time of the generating bar (callers feed closed-only
      // candles, so the last setup bar is closed by construction).
      timestamp: setup.length > 0 ? setup[setup.length - 1].timestamp + timeframeToMs(setupTimeframe) : dataTimestamp,
      timeframe: setupTimeframe,
      direction,
      signalStrength: scored.score,
      classification: direction === "WAIT" ? "WAIT" : scored.classification,
      entryLow,
      entryHigh,
      entryType:
        direction === "WAIT" || entryLow === null || entryHigh === null
          ? null
          : price >= entryLow && price <= entryHigh
            ? "MARKET"
            : "RETEST",
      entryStatus:
        direction === "WAIT" || entryLow === null || entryHigh === null
          ? null
          : price >= entryLow && price <= entryHigh
            ? "READY"
            : "WAIT_FOR_RETEST",
      invalidation,
      tp1,
      tp2,
      tp3,
      riskReward,
      trend: trend.label,
      momentum: momentum.label,
      rsi: rsiNow,
      volume: volumeP.label,
      marketStructure: structure.label,
      brokeAbove: structure.brokeAbove,
      brokeBelow: structure.brokeBelow,
      retestHeld: structure.retestHeldAbove || structure.retestHeldBelow,
      riskAtr:
        entryLow !== null && invalidation !== null && direction !== "WAIT"
          ? Math.abs((entryLow + (entryHigh ?? entryLow)) / 2 - invalidation) / (atr as number)
          : null,
      atrPct: Math.round(((atr as number) / price) * 10000) / 100,
      falseBreakout:
        direction === "LONG" ? structure.falseBreakoutUp : structure.falseBreakoutDown,
      multiTimeframe: mtf,
      components: scored.components,
      bounce,
      reasons,
      warnings,
      dataTimestamp,
      longScore: scored.longScore,
      shortScore: scored.shortScore,
    },
  };
}

/** Bounce-page listing rule: scored setup + agreeing bounce detector. */
export function isListableBounce(signal: Signal): boolean {
  return (
    signal.direction !== "WAIT" &&
    signal.signalStrength >= 60 &&
    signal.bounce !== null &&
    signal.bounce.direction === signal.direction &&
    signal.bounce.bounceScore >= 60
  );
}
