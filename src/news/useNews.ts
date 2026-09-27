import { useEffect, useState } from "react";
import { defaultNewsProvider, type NewsItem } from "./index";

/**
 * Verified news for one symbol. Provider failures resolve to [] so the UI
 * shows "No significant verified recent catalyst found." — never an error
 * wall, never invented items.
 */
export function useNews(symbol: string): { items: NewsItem[]; loading: boolean } {
  const coin = symbol.toUpperCase();
  const [items, setItems] = useState<NewsItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    defaultNewsProvider()
      .fetchNews(coin)
      .then((list) => {
        if (!cancelled) {
          setItems(list.slice(0, 10));
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setItems([]);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [coin]);

  return { items, loading };
}

/** Newest relevant item per symbol, for bounce-row catalyst cells. */
export function useNewsBatch(symbols: string[]): Map<string, NewsItem | null> {
  const key = [...new Set(symbols.map((s) => s.toUpperCase()))].sort().join(",");
  const [map, setMap] = useState<Map<string, NewsItem | null>>(new Map());

  useEffect(() => {
    const list = key === "" ? [] : key.split(",");
    let cancelled = false;
    const provider = defaultNewsProvider();
    Promise.all(
      list.map(async (symbol) => {
        try {
          const items = await provider.fetchNews(symbol);
          return [symbol, items[0] ?? null] as const;
        } catch {
          return [symbol, null] as const;
        }
      }),
    ).then((rows) => {
      if (!cancelled) setMap(new Map(rows));
    });
    return () => {
      cancelled = true;
    };
  }, [key]);

  return map;
}
