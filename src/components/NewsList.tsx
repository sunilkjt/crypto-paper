import { Card, CardHeader } from "./ui";
import type { NewsItem } from "../news/types";

export function timeAgo(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return "date unavailable";
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return m === 1 ? "1 minute ago" : `${m} minutes ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return h === 1 ? "1 hour ago" : `${h} hours ago`;
  const d = Math.floor(h / 24);
  return d === 1 ? "1 day ago" : `${d} days ago`;
}

const SENTIMENT_STYLE: Record<NewsItem["sentiment"], string> = {
  POSITIVE: "border-emerald-400/30 bg-emerald-400/10 text-emerald-300",
  NEGATIVE: "border-rose-400/30 bg-rose-400/10 text-rose-300",
  NEUTRAL: "border-slate-700 bg-slate-800 text-slate-300",
  UNCERTAIN: "border-slate-700 bg-slate-900 text-slate-400",
};

/**
 * Verified news list. Every item links its source; links open in a new
 * tab with opener protection. Empty states are explicit, never invented.
 */
export function NewsList({ items, loading }: { items: NewsItem[]; loading: boolean }) {
  return (
    <Card>
      <CardHeader
        title="Recent Verified News"
        subtitle="Coin-relevant items with verifiable sources only"
      />
      {loading ? (
        <p className="px-5 py-8 text-center text-sm text-slate-400">Checking verified sources…</p>
      ) : items.length === 0 ? (
        <div className="px-5 py-8 text-center">
          <p className="text-sm font-semibold text-slate-200">No significant verified recent catalyst found.</p>
          <p className="mx-auto mt-1 max-w-md text-xs text-slate-500">
            No reliable source currently carries coin-relevant news. Unverified or unrelated items are withheld, not shown.
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-slate-800/70">
          {items.map((n) => (
            <li key={n.id} className="px-5 py-4">
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-bold tracking-widest ${SENTIMENT_STYLE[n.sentiment]}`}
                >
                  {n.sentiment}
                </span>
                <span className="text-[11px] text-slate-500">
                  {n.source} · {timeAgo(n.publishedAt)}
                </span>
              </div>
              <a
                href={n.url}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-1.5 block text-sm font-bold text-slate-100 hover:text-cyan-300 hover:underline"
              >
                {n.headline}
              </a>
              {n.summary !== "" && <p className="mt-1 text-xs leading-relaxed text-slate-400">{n.summary}</p>}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
