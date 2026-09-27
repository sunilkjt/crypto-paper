import type { BacktestMetrics, BacktestTrade, EquityPoint, StrengthBucket } from "./types";

/**
 * Pure performance math over closed simulated trades. Winners = R > 0.
 * Profit factor = gross profit / gross loss (Infinity when no losers,
 * 0 when no winners). Drawdown from the equity series peak-to-trough.
 */

export function computeMetrics(trades: BacktestTrade[], startingBalance: number): BacktestMetrics {
  const total = trades.length;
  const zero: BacktestMetrics = {
    totalTrades: 0,
    winningTrades: 0,
    losingTrades: 0,
    winRate: 0,
    averageR: 0,
    medianR: 0,
    profitFactor: 0,
    netPnl: 0,
    returnPct: 0,
    maxDrawdown: 0,
    maxDrawdownPct: 0,
    averageTrade: 0,
    bestTrade: 0,
    worstTrade: 0,
    averageHoldingMs: 0,
    tp1HitRate: 0,
    tp2HitRate: 0,
    tp3HitRate: 0,
    invalidationRate: 0,
  };
  if (total === 0) return zero;

  const rs = trades.map((t) => t.rMultiple).sort((a, b) => a - b);
  const wins = trades.filter((t) => t.rMultiple > 0);
  const losses = trades.filter((t) => t.rMultiple <= 0);
  const grossProfit = wins.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
  const netPnl = trades.reduce((a, t) => a + t.pnl, 0);

  // Equity + drawdown walk.
  let equity = startingBalance;
  let peak = startingBalance;
  let maxDd = 0;
  let maxDdPct = 0;
  for (const t of [...trades].sort((a, b) => a.exitTimestamp - b.exitTimestamp)) {
    equity += t.pnl;
    peak = Math.max(peak, equity);
    const dd = peak - equity;
    maxDd = Math.max(maxDd, dd);
    if (peak > 0) maxDdPct = Math.max(maxDdPct, (dd / peak) * 100);
  }

  const mid = Math.floor(rs.length / 2);
  const medianR = rs.length % 2 === 1 ? rs[mid] : (rs[mid - 1] + rs[mid]) / 2;
  const round2 = (n: number) => Math.round(n * 100) / 100;

  return {
    totalTrades: total,
    winningTrades: wins.length,
    losingTrades: losses.length,
    winRate: round2((wins.length / total) * 100),
    averageR: round2(rs.reduce((a, b) => a + b, 0) / total),
    medianR: round2(medianR),
    profitFactor: grossLoss > 0 ? round2(grossProfit / grossLoss) : wins.length > 0 ? Infinity : 0,
    netPnl: round2(netPnl),
    returnPct: startingBalance > 0 ? round2((netPnl / startingBalance) * 100) : 0,
    maxDrawdown: round2(maxDd),
    maxDrawdownPct: round2(maxDdPct),
    averageTrade: round2(netPnl / total),
    bestTrade: round2(Math.max(...trades.map((t) => t.pnl))),
    worstTrade: round2(Math.min(...trades.map((t) => t.pnl))),
    averageHoldingMs: Math.round(trades.reduce((a, t) => a + t.durationMs, 0) / total),
    tp1HitRate: round2((trades.filter((t) => t.result === "TP1" || t.result === "TP2" || t.result === "TP3").length / total) * 100),
    tp2HitRate: round2((trades.filter((t) => t.result === "TP2" || t.result === "TP3").length / total) * 100),
    tp3HitRate: round2((trades.filter((t) => t.result === "TP3").length / total) * 100),
    invalidationRate: round2((trades.filter((t) => t.result === "STOPPED").length / total) * 100),
  };
}

export function buildEquityCurve(trades: BacktestTrade[], startingBalance: number): EquityPoint[] {
  const points: EquityPoint[] = [{ timestamp: 0, equity: startingBalance, drawdownPct: 0 }];
  let equity = startingBalance;
  let peak = startingBalance;
  for (const t of [...trades].sort((a, b) => a.exitTimestamp - b.exitTimestamp)) {
    equity += t.pnl;
    peak = Math.max(peak, equity);
    points.push({
      timestamp: t.exitTimestamp,
      equity: Math.round(equity * 100) / 100,
      drawdownPct: peak > 0 ? Math.round(((peak - equity) / peak) * 10000) / 100 : 0,
    });
  }
  return points;
}

function bucketize(trades: BacktestTrade[], key: (t: BacktestTrade) => string, order: string[]): StrengthBucket[] {
  return order.map((band) => {
    const group = trades.filter((t) => key(t) === band);
    const wins = group.filter((t) => t.rMultiple > 0).length;
    return {
      band,
      trades: group.length,
      wins,
      averageR: group.length > 0 ? Math.round((group.reduce((a, t) => a + t.rMultiple, 0) / group.length) * 100) / 100 : 0,
    };
  });
}

export function strengthBands(trades: BacktestTrade[]): StrengthBucket[] {
  const band = (s: number) =>
    s >= 90 ? "90–100" : s >= 75 ? "75–89" : s >= 60 ? "60–74" : s >= 40 ? "40–59" : "0–39";
  return bucketize(trades, (t) => band(t.strength), ["90–100", "75–89", "60–74", "40–59", "0–39"]);
}

export function setupBands(trades: BacktestTrade[]): StrengthBucket[] {
  return bucketize(
    trades,
    (t) => t.setupType,
    ["BOUNCE", "BREAKOUT", "BREAKDOWN", "PULLBACK", "REVERSAL", "TREND", "RANGE"],
  );
}

export function directionBands(trades: BacktestTrade[]): StrengthBucket[] {
  return bucketize(trades, (t) => t.direction, ["LONG", "SHORT"]);
}
