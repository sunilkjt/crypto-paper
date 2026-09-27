import {
  AiInvalidResponseError,
  type AiAnalysis,
  type AiAnalysisInput,
  type AiDirection,
} from "./types";

/**
 * Response guard. Accepts ONLY the documented text schema; unknown fields
 * (especially any numeric "price/RSI/entry" inventions) are dropped, and a
 * directionEcho that disagrees with the engine rejects the whole response.
 * The UI renders the returned strings as plain text (never HTML).
 */

const REQUIRED_TEXT = ["summary", "marketStructure", "setup", "invalidation", "conclusion"] as const;
const REQUIRED_LISTS = ["confirmations", "conflicts", "risks", "catalysts"] as const;

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= 4000;
}

function toStringList(v: unknown): string[] {
  if (!Array.isArray(v)) throw new AiInvalidResponseError("AI list field must be an array.");
  return v.map((item) => {
    if (typeof item !== "string") throw new AiInvalidResponseError("AI list items must be strings.");
    return item.slice(0, 1000);
  });
}

function stripHtml(s: string): string {
  return s.replace(/[<>&]/g, (c) => (c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&amp;"));
}

export function validateAiResponse(
  raw: unknown,
  expected: { direction: AiDirection; provider: string; marketDataTimestamp: number },
): AiAnalysis {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new AiInvalidResponseError("AI response must be a JSON object.");
  }
  const o = raw as Record<string, unknown>;

  if (o.directionEcho !== expected.direction) {
    throw new AiInvalidResponseError(
      `AI directionEcho ${String(o.directionEcho)} conflicts with engine ${expected.direction} — rejected.`,
    );
  }
  for (const k of REQUIRED_TEXT) {
    if (!isNonEmptyString(o[k])) {
      throw new AiInvalidResponseError(`AI response missing text field "${k}".`);
    }
  }
  const lists: Record<(typeof REQUIRED_LISTS)[number], string[]> = {
    confirmations: [],
    conflicts: [],
    risks: [],
    catalysts: [],
  };
  for (const k of REQUIRED_LISTS) lists[k] = toStringList(o[k]);

  return {
    summary: stripHtml(o.summary as string),
    marketStructure: stripHtml(o.marketStructure as string),
    setup: stripHtml(o.setup as string),
    confirmations: lists.confirmations.map(stripHtml),
    conflicts: lists.conflicts.map(stripHtml),
    risks: lists.risks.map(stripHtml),
    invalidation: stripHtml(o.invalidation as string),
    catalysts: lists.catalysts.map(stripHtml),
    conclusion: stripHtml(o.conclusion as string),
    directionEcho: expected.direction,
    provider: expected.provider,
    analysisTimestamp: Date.now(),
    marketDataTimestamp: expected.marketDataTimestamp,
  };
}

/** Shape check for the structured input handed to providers (tests + debug). */
export function isValidAiInput(input: unknown): input is AiAnalysisInput {
  if (typeof input !== "object" || input === null) return false;
  const o = input as Record<string, unknown>;
  return (
    typeof o.symbol === "string" &&
    ["LONG", "SHORT", "WAIT"].includes(o.signalDirection as string) &&
    typeof o.signalStrength === "number" &&
    typeof o.timeframes === "object" &&
    o.timeframes !== null &&
    Array.isArray(o.signalReasons) &&
    Array.isArray(o.signalWarnings) &&
    Array.isArray(o.news)
  );
}
