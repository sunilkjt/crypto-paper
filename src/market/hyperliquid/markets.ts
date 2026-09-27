import type {
  Market,
  RawAssetCtx,
  RawMetaAndAssetCtxs,
  RawUniverseEntry,
} from "./types";
import { HyperliquidError } from "./types";

function toNumberOrNull(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function dayChangePct(markPx: number | null, prevDayPx: number | null): number | null {
  if (markPx === null || prevDayPx === null || prevDayPx === 0) return null;
  return ((markPx - prevDayPx) / prevDayPx) * 100;
}

/**
 * Normalize one universe entry + its asset context into a Market.
 * Never throws on bad numbers — degrades to null fields instead.
 */
export function normalizeMarket(
  entry: RawUniverseEntry,
  ctx: RawAssetCtx | undefined,
): Market {
  const markPrice = toNumberOrNull(ctx?.markPx);
  const oraclePrice = toNumberOrNull(ctx?.oraclePx);
  const midPrice = toNumberOrNull(ctx?.midPx);
  const prevDayPrice = toNumberOrNull(ctx?.prevDayPx);
  const dayVolumeNotional = toNumberOrNull(ctx?.dayNtlVlm);
  const fundingRate = toNumberOrNull(ctx?.funding);
  const openInterestCoins = toNumberOrNull(ctx?.openInterest);

  return {
    symbol: entry.name,
    markPrice,
    oraclePrice,
    dayVolumeNotional,
    dayChangePct: dayChangePct(markPrice ?? midPrice, prevDayPrice),
    fundingRate,
    openInterestCoins,
    openInterestNotional:
      openInterestCoins !== null && markPrice !== null
        ? openInterestCoins * markPrice
        : null,
    prevDayPrice,
    midPrice,
  };
}

/** Normalize a full metaAndAssetCtxs payload. Skips delisted entries. */
export function normalizeMetaAndAssetCtxs(payload: unknown): Market[] {
  if (!Array.isArray(payload) || payload.length !== 2) {
    throw new HyperliquidError(
      "invalid-response",
      "Unable to retrieve Hyperliquid market data (bad universe shape). Retrying…",
    );
  }
  const [meta, ctxs] = payload as RawMetaAndAssetCtxs;
  const out = normalizeDexTuple(meta, ctxs);
  if (out.length === 0) {
    throw new HyperliquidError(
      "invalid-response",
      "Unable to retrieve Hyperliquid market data (empty universe). Retrying…",
    );
  }
  return out;
}

function normalizeDexTuple(
  meta: { universe: RawUniverseEntry[] } | null | undefined,
  ctxs: RawAssetCtx[] | null | undefined,
): Market[] {
  if (!meta || !Array.isArray(meta.universe) || !Array.isArray(ctxs)) {
    throw new HyperliquidError(
      "invalid-response",
      "Unable to retrieve Hyperliquid market data (bad universe shape). Retrying…",
    );
  }
  const out: Market[] = [];
  meta.universe.forEach((entry, i) => {
    if (!entry || typeof entry.name !== "string" || entry.isDelisted) return;
    out.push(normalizeMarket(entry, ctxs[i]));
  });
  return out;
}

/**
 * Normalize a perpDexs payload: [null, {name}, ...] -> ["", "xyz", ...].
 * "" is the main dex (Hyperliquid defaults to it when dex is omitted).
 */
export function normalizePerpDexs(payload: unknown): string[] {
  if (!Array.isArray(payload)) {
    throw new HyperliquidError(
      "invalid-response",
      "Unable to retrieve Hyperliquid market data (bad dex list shape). Retrying…",
    );
  }
  const out: string[] = [];
  for (const entry of payload as unknown[]) {
    if (entry === null) {
      if (!out.includes("")) out.push("");
      continue;
    }
    if (typeof entry === "object" && entry !== null) {
      const name = (entry as { name?: unknown }).name;
      if (typeof name === "string" && name.length > 0 && !out.includes(name)) {
        out.push(name);
      }
    }
  }
  if (out.length === 0) {
    throw new HyperliquidError(
      "invalid-response",
      "Unable to retrieve Hyperliquid market data (empty dex list). Retrying…",
    );
  }
  // Main dex first so its snapshot wins on symbol collision.
  out.sort((a, b) => (a === "" ? -1 : b === "" ? 1 : 0));
  return out;
}

/**
 * Merge per-dex market lists into one universe. First list wins on
 * symbol collision (main dex is always first). HIP-3 names are
 * dex-prefixed, so collisions are not expected in practice.
 */
export function mergeDexMarkets(lists: Market[][]): Market[] {
  const seen = new Set<string>();
  const out: Market[] = [];
  for (const list of lists) {
    for (const m of list) {
      if (seen.has(m.symbol)) continue;
      seen.add(m.symbol);
      out.push(m);
    }
  }
  if (out.length === 0) {
    throw new HyperliquidError(
      "invalid-response",
      "Unable to retrieve Hyperliquid market data (empty universe). Retrying…",
    );
  }
  return out;
}

/** Normalize allMids payload: Record<symbol, priceString>. */
export function normalizeAllMids(payload: unknown): Record<string, number> {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new HyperliquidError(
      "invalid-response",
      "Unable to retrieve Hyperliquid market data (bad mids shape). Retrying…",
    );
  }
  const out: Record<string, number> = {};
  for (const [symbol, raw] of Object.entries(payload as Record<string, unknown>)) {
    const n = typeof raw === "string" ? Number(raw) : NaN;
    if (typeof symbol === "string" && Number.isFinite(n)) out[symbol] = n;
  }
  return out;
}

/**
 * Merge streaming mid prices into a market snapshot (pure, no mutation).
 * Mid updates also refresh markPrice when mark is missing, so tickers stay alive.
 */
export function mergeLivePrices(markets: Market[], mids: Record<string, number>): Market[] {
  if (Object.keys(mids).length === 0) return markets;
  return markets.map((m) => {
    const live = mids[m.symbol];
    if (live === undefined || !Number.isFinite(live)) return m;
    const markPrice = m.markPrice ?? live;
    return {
      ...m,
      midPrice: live,
      markPrice,
      dayChangePct:
        m.dayChangePct ??
        (m.prevDayPrice ? ((markPrice - m.prevDayPrice) / m.prevDayPrice) * 100 : null),
      openInterestNotional:
        m.openInterestCoins !== null ? m.openInterestCoins * markPrice : null,
    };
  });
}

export function findMarket(markets: Market[], symbol: string): Market {
  const upper = symbol.toUpperCase();
  const found = markets.find((m) => m.symbol.toUpperCase() === upper);
  if (!found) {
    throw new HyperliquidError("missing-market", `Market ${upper} is not listed on Hyperliquid.`, false);
  }
  return found;
}
