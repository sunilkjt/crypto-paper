import { normalizeNewsItem, type NewsItem, type NewsProvider } from "./types";
import { scoreRelevance } from "./relevance";

/**
 * Aggregation: normalize → drop unverifiable → dedupe by URL → keep only
 * relevant → newest first. Failures resolve to [] so the UI shows the
 * honest "no verified catalyst" state instead of errors.
 */

/** Default provider: no backend configured → no news (honest empty state). */
export class EmptyNewsProvider implements NewsProvider {
  readonly name = "empty";
  async fetchNews(_symbol: string): Promise<NewsItem[]> {
    void _symbol;
    return [];
  }
}

/** Backend provider: GET {endpoint}?symbol=OP → JSON array of records. */
export class HttpNewsProvider implements NewsProvider {
  readonly name = "http-news";
  private readonly endpoint: string;

  constructor(endpoint: string) {
    if (!endpoint || !/^https:\/\//.test(endpoint)) {
      throw new Error("HttpNewsProvider requires an https:// backend endpoint.");
    }
    this.endpoint = endpoint;
  }

  async fetchNews(
    symbol: string,
    opts?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<NewsItem[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts?.timeoutMs ?? 15_000);
    const onAbort = () => controller.abort();
    opts?.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const res = await fetch(
        `${this.endpoint}?symbol=${encodeURIComponent(symbol.toUpperCase())}`,
        { signal: controller.signal },
      );
      if (!res.ok) return [];
      let payload: unknown;
      try {
        payload = (await res.json()) as unknown;
      } catch {
        return [];
      }
      if (!Array.isArray(payload)) return [];
      return aggregateNews(symbol, payload);
    } catch {
      return [];
    } finally {
      clearTimeout(timer);
      opts?.signal?.removeEventListener("abort", onAbort);
    }
  }
}

export function newsEndpointFromEnv(): string {
  try {
    const v = (import.meta as unknown as { env?: Record<string, string | undefined> }).env
      ?.VITE_NEWS_ENDPOINT;
    return typeof v === "string" ? v.trim() : "";
  } catch {
    return "";
  }
}

export function defaultNewsProvider(): NewsProvider {
  const endpoint = newsEndpointFromEnv();
  return endpoint !== "" ? new HttpNewsProvider(endpoint) : new EmptyNewsProvider();
}

/** Pure pipeline used by providers and tests. */
export function aggregateNews(symbol: string, records: unknown[]): NewsItem[] {
  const seen = new Set<string>();
  const out: NewsItem[] = [];
  for (const raw of records) {
    let item: NewsItem;
    try {
      item = normalizeNewsItem(raw, symbol);
    } catch {
      continue; // unverifiable → dropped, never guessed
    }
    if (seen.has(item.url)) continue;
    seen.add(item.url);
    const rel = scoreRelevance(symbol, item.headline, item.summary);
    if (!rel.relevant) continue;
    out.push(item);
  }
  // Newest first; unknown dates (0) sink to the bottom.
  out.sort((a, b) => b.publishedAt - a.publishedAt);
  return out;
}
