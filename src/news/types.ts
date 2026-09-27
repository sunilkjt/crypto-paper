/**
 * News types. Items originate from providers (backend endpoints) — never
 * invented locally. Unverifiable fields degrade to safe fallbacks.
 */

export type NewsSentiment = "POSITIVE" | "NEGATIVE" | "NEUTRAL" | "UNCERTAIN";

export interface NewsItem {
  id: string;
  headline: string;
  source: string;
  url: string;
  publishedAt: number;
  symbol: string;
  summary: string;
  sentiment: NewsSentiment;
}

export interface NewsProvider {
  readonly name: string;
  fetchNews(symbol: string, opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<NewsItem[]>;
}

export const SENTIMENTS: readonly NewsSentiment[] = [
  "POSITIVE",
  "NEGATIVE",
  "NEUTRAL",
  "UNCERTAIN",
] as const;

export function normalizeSentiment(v: unknown): NewsSentiment {
  return typeof v === "string" &&
    (SENTIMENTS as readonly string[]).includes(v.toUpperCase())
    ? (v.toUpperCase() as NewsSentiment)
    : "UNCERTAIN";
}

/** Validate + sanitize one raw provider record. Throws on missing identity. */
export function normalizeNewsItem(raw: unknown, fallbackSymbol: string): NewsItem {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("News record must be an object.");
  }
  const o = raw as Record<string, unknown>;
  const id = typeof o.id === "string" && o.id.length > 0 ? o.id : null;
  const headline = typeof o.headline === "string" && o.headline.length > 0 ? o.headline : null;
  const url = typeof o.url === "string" && /^https:\/\//.test(o.url) ? o.url : "";
  if (!id || !headline) throw new Error("News record needs id + headline.");
  if (!url) throw new Error("News without a verifiable https URL is dropped.");
  const publishedAt =
    typeof o.publishedAt === "number" && Number.isFinite(o.publishedAt) && o.publishedAt > 0
      ? o.publishedAt
      : 0; // 0 = unknown date, displayed as "date unavailable", never guessed
  return {
    id: id.slice(0, 200),
    headline: headline.slice(0, 300),
    source: typeof o.source === "string" && o.source.length > 0 ? o.source.slice(0, 120) : "Unknown source",
    url,
    publishedAt,
    symbol:
      typeof o.symbol === "string" && o.symbol.length > 0
        ? o.symbol.toUpperCase().slice(0, 24)
        : fallbackSymbol.toUpperCase(),
    summary: typeof o.summary === "string" ? o.summary.slice(0, 600) : "",
    sentiment: normalizeSentiment(o.sentiment),
  };
}
