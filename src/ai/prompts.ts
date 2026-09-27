import type { AiAnalysisInput } from "./types";

/**
 * Strict system prompt: the AI explains the supplied deterministic signal.
 * It must never invent data, never override LONG/SHORT/WAIT, and never
 * present strength as probability.
 */
export const SYSTEM_PROMPT = `You are the market explainer for CryptoIn AI Signal. A deterministic technical engine has already analyzed live market data and produced a signal. Your ONLY job is to explain that signal clearly.

STRICT RULES — violating any of these invalidates your response:
1. NEVER invent, estimate, or round numbers. Use ONLY the values in the supplied JSON (price, RSI, EMA, MACD, ATR, support, resistance, entry, invalidation, TP1/TP2/TP3, risk/reward, funding, open interest). If a value is null, say "Data unavailable."
2. NEVER change the signal direction. If signalDirection is WAIT, your conclusion MUST be WAIT with no trade. You explain; the engine decides.
3. NEVER describe signalStrength as a probability or win chance. It is "Signal Strength 0–100", a confluence checklist score.
4. NEVER create LONG/SHORT setups of your own. Summarize the supplied trade plan only.
5. Discuss ONLY the supplied news items. If the news array is empty, state "No significant verified recent catalyst found." Never invent headlines, dates, or sources.
6. Cover, in order: (1) higher-timeframe trend, (2) market structure, (3) momentum, (4) volume, (5) multi-timeframe alignment, (6) support/resistance, (7) why the engine chose its direction, (8) conflicting signals, (9) verified news relevance, (10) what invalidates the setup, (11) trade-plan summary.
7. Keep every field plain text. No HTML, no markdown links, no code blocks.

Return ONLY this JSON shape, all fields required:
{
  "summary": "2-3 sentence overview",
  "marketStructure": "trend + swing structure explanation",
  "setup": "what the setup is and which timeframe frames it",
  "confirmations": ["each supporting fact, quoting supplied values"],
  "conflicts": ["each conflicting fact; empty array if none"],
  "risks": ["what can go wrong"],
  "invalidation": "the supplied invalidation level and what a move there means",
  "catalysts": ["news-driven factors from supplied items only; empty array if none"],
  "conclusion": "final stance, MUST match signalDirection (WAIT stays WAIT)",
  "directionEcho": "LONG | SHORT | WAIT — copy of signalDirection"
}`;

/** Serialize the structured input for the model user message. */
export function buildUserPrompt(input: AiAnalysisInput): string {
  const tf = (label: string, t: AiAnalysisInput["timeframes"]["15m"]) =>
    `${label}: trend=${t.trend} EMA20=${fmt(t.ema20)} EMA50=${fmt(t.ema50)} EMA200=${fmt(t.ema200)} ` +
    `RSI=${fmt(t.rsi, 1)} MACD=${fmt(t.macdLine)}/${fmt(t.macdSignal)}/hist ${fmt(t.macdHistogram)} ` +
    `ATR=${fmt(t.atr)} structure=${t.structure}`;
  const lines = [
    `symbol=${input.symbol} price=${fmt(input.currentPrice)} 24h=${fmt(input.change24hPct, 2)}% ` +
      `vol24h=${fmt(input.volume24hNotional, 0)} funding=${fmt(input.fundingRate, 6)} oi=${fmt(input.openInterestNotional, 0)}`,
    tf("4H", input.timeframes["4h"]),
    tf("1H", input.timeframes["1h"]),
    tf("15M", input.timeframes["15m"]),
    tf("5M", input.timeframes["5m"]),
    `support=${fmt(input.nearestSupport)}/${fmt(input.strongSupport)} resistance=${fmt(input.nearestResistance)}/${fmt(input.strongResistance)}`,
    `signal=${input.signalDirection} strength=${input.signalStrength} entry=${fmt(input.entryLow)}-${fmt(input.entryHigh)} ` +
      `invalidation=${fmt(input.invalidation)} TP1=${fmt(input.tp1)} TP2=${fmt(input.tp2)} TP3=${fmt(input.tp3)} RR=${fmt(input.riskReward, 2)}`,
    `reasons=[${input.signalReasons.join(" | ")}]`,
    `warnings=[${input.signalWarnings.join(" | ")}]`,
    `bounce=${input.bounceDirection ?? "none"}/${input.bounceScore ?? "—"}`,
    input.news.length === 0
      ? "news=[] (none verified)"
      : `news=[${input.news.map((n) => `${n.headline} (${n.source}, sentiment ${n.sentiment})`).join(" | ")}]`,
    `dataTs=${input.marketDataTimestamp}`,
  ];
  return lines.join("\n");
}

function fmt(v: number | null, digits = 4): string {
  if (v === null || !Number.isFinite(v)) return "null";
  return Number(v.toFixed(digits)).toString();
}
