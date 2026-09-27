import type { AiAnalysis, AiAnalysisInput, AIProvider } from "../types";
import { validateAiResponse } from "../validate";

/**
 * Deterministic local explainer — NOT an LLM. It renders the engine's own
 * numbers into the nine-block schema with fixed sentence templates, so the
 * AI sections are live and truthful even with no backend configured.
 * Always badged "LOCAL · NOT AN LLM" in the UI.
 */
export class LocalExplainerProvider implements AIProvider {
  readonly name = "local-explainer";
  readonly kind = "local-explainer" as const;

  async analyze(input: AiAnalysisInput): Promise<AiAnalysis> {
    const f = (v: number | null, digits = 4): string => {
      if (v === null || !Number.isFinite(v)) return "Data unavailable";
      return v.toLocaleString("en-US", { maximumFractionDigits: digits });
    };
    const dir = input.signalDirection;
    const dirWord = dir === "WAIT" ? "no directional trade" : `a ${dir} setup`;
    const t15 = input.timeframes["15m"];
    const t4 = input.timeframes["4h"];

    const raw = {
      summary:
        `${input.symbol} is priced at ${f(input.currentPrice)} with a 24h change of ` +
        `${input.change24hPct === null ? "Data unavailable" : `${input.change24hPct.toFixed(2)}%`}. ` +
        `The deterministic engine scores ${dirWord} at Signal Strength ${input.signalStrength}/100. ` +
        (dir === "WAIT"
          ? "Evidence is mixed or insufficient, so no trade is forced."
          : `The plan risks invalidation at ${f(input.invalidation)} for targets up to ${f(input.tp3)}.`),
      marketStructure:
        `Higher-timeframe trend reads ${t4.trend} on 4H. The 15M setup frame shows ` +
        `${t15.trend} structure with RSI ${f(t15.rsi, 1)} and MACD histogram ${f(t15.macdHistogram)}. ` +
        `Nearest support sits at ${f(input.nearestSupport)} and nearest resistance at ${f(input.nearestResistance)}.`,
      setup:
        dir === "WAIT"
          ? "No setup: the engine requires stronger multi-confirmation agreement before trading."
          : `${dir} setup framed on 15M: entry zone ${f(input.entryLow)}–${f(input.entryHigh)}, ` +
            `invalidation ${f(input.invalidation)}, TP1 ${f(input.tp1)}, TP2 ${f(input.tp2)}, TP3 ${f(input.tp3)}.`,
      confirmations: input.signalReasons.length > 0 ? [...input.signalReasons] : ["No individual confirmations recorded."],
      conflicts: input.signalWarnings.length > 0 ? [...input.signalWarnings] : [],
      risks: [
        "A break of invalidation ends the thesis immediately.",
        input.volume24hNotional !== null && input.volume24hNotional > 0
          ? "Thin participation can exaggerate moves and slippage."
          : "Data unavailable on participation depth.",
        ...(input.fundingRate !== null && Math.abs(input.fundingRate) > 0.0005
          ? ["Elevated funding rate leans against holding the position."]
          : []),
      ],
      invalidation:
        input.invalidation === null
          ? "Data unavailable — no invalidation level was computed, so no trade is defined."
          : `A move through ${f(input.invalidation)} invalidates the ${dir} structure and ends the setup.`,
      catalysts:
        input.news.length === 0
          ? []
          : input.news.map((n) => `${n.headline} (${n.source}, ${n.sentiment.toLowerCase()})`),
      conclusion:
        dir === "WAIT"
          ? `WAIT. Signal Strength ${input.signalStrength}/100 is below a tradable bar or evidence is mixed. No position.`
          : `${dir} with Signal Strength ${input.signalStrength}/100. Follow the supplied plan and honor invalidation. ` +
            `Strength is confluence, not a probability of success.`,
      directionEcho: dir,
    };

    return validateAiResponse(raw, {
      direction: dir,
      provider: this.name,
      marketDataTimestamp: input.marketDataTimestamp,
    });
  }
}
