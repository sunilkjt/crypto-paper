# CryptoIn AI Signal — Phase 8 (Rate Limits + Performance) ✅

Same signals, cheaper data access. **Fetch-layer only: no indicator, scoring,
weight, plan, or design changes. Ranks mean exactly what they meant before.**

Tech: React + TypeScript + Vite + Tailwind CSS v4 + Recharts + React Router + Lucide + Vitest.

## Phase 2 completed

- [x] Hyperliquid connection (public `/info` REST + `wss` WebSocket, no API keys)
- [x] Market list via `getMarkets()` — never hardcoded (main dex + HIP-3 builder dexes, ~360 markets)
- [x] Live prices on Dashboard + Scanner with `LIVE` / `DATA STALE` states
- [x] Candle history via `getCandles(symbol, timeframe, startTime, endTime)` → normalized `Candle`
- [x] Coin Analysis (`/coin/OP`) with real KPIs + full-window SVG candlestick chart + 1m/5m/15m/1h/4h switching (no reload)
- [x] Connection status: `CONNECTING` 🟡 / `ONLINE` 🟢 / `DEGRADED` 🟠 / `OFFLINE` 🔴 — ONLINE requires recently received data, never page load — plus `Last update: X seconds ago` in the topbar and on every market page
- [x] Realtime: WebSocket first, HTTPS polling fallback (`realtime.ts`), single shared socket
- [x] Cache: TTL + concurrent-request coalescing, stale expiry, error recovery (in-memory only, no Redis)
- [x] Offline snapshot: last good markets universe persisted to localStorage, painted instantly (stale-flagged) on reload/offline
- [x] Error handling: network/API/invalid/missing-market/missing-candles/WS-disconnect/rate-limit/timeout → `"Unable to retrieve Hyperliquid market data. Retrying…"` — never fabricated prices
- [x] Freshness: `Last updated: X seconds ago` + `DATA STALE` past threshold (markets 60s, candles 90s)
- [x] Search (client-side, no per-keystroke requests) + sorting (price/24h/volume/funding/OI, client-side) + pagination (25/page)
- [x] Strict TypeScript types: `Market, Candle, Ticker, Funding, OpenInterest, MarketData, Timeframe` — no `any`
- [x] Tests (mocked, 40 passing) + `npm run build` green (Phase 2 baseline)

## Phase 3 completed — deterministic engine (no LLM)

Indicators (`src/indicators/`, all local OHLCV math, null = insufficient data):
- EMA 20/50/200 (SMA-seeded), RSI 14 (Wilder), MACD 12/26/9 + histogram, ATR 14 (Wilder TR), volume avg/relVol/spike (current excluded from average)

Scoring (`src/analysis/`): Trend 25 (EMA-stack 5-point vote + ATR-epsilon) ·
Momentum 20 (RSI recovery, never blind oversold + MACD improvement) ·
Volume 15 (direction-agnostic confirmation) · Structure 20 (HH/HL/LH/LL swings,
close-confirmed breakouts, retests, false-breakout veto) ·
MTF 20 (4H major / 1H structure / 15M setup / 5M entry, conflicts halve it).
`calculateSignalScore()` scores LONG and SHORT independently; mixed or weak
evidence → WAIT (min edge 10, min score 40, plus range + chop-regime guards).

Bands: 0–39 WAIT · 40–59 WATCH · 60–74 SETUP · 75–89 STRONG SETUP · 90–100
HIGH-CONFLUENCE SETUP. Strength categories, never success probabilities.

Trade plans from structure only (no fixed %): entry zone, swing/SR/ATR
invalidation, TP1<TP2<TP3 (LONG, mirrored SHORT) with R floors, R:R to mean TP.

`#/bounce` scans top-25 by volume (bounded concurrency, progress bar, stale
guard) and lists only agreeing bounce setups ≥ SETUP, else
"No high-confluence bounce setups currently detected." `INSUFFICIENT DATA`
below 210 setup candles; `DATA STALE` never mints fresh signals.

- [x] Tests (mocked, 101 passing) + `npm run build` green (Phase 3 baseline)

## Phase 4 completed — AI analyst + news (engine still decides)

AI module (`src/ai/`): `AIProvider` abstraction (`LocalExplainerProvider`
default, clearly badged LOCAL · NOT AN LLM; `HttpAiProvider` active only when
`VITE_AI_ENDPOINT` points at your own key-holding backend). Strict system
prompt (11 duties, WAIT stays WAIT, strength is never probability). Structured
input (engine numbers + market snapshot + verified news, copied never computed)
and 9-block JSON output validated centrally — direction conflicts and invented
numeric fields are rejected, HTML escaped, rendering is text-only.
Cache key `symbol+timeframe+signalTs+dataTs` (15-min TTL); throttle 10s/key,
max 2 concurrent, in-flight dedupe, timeouts; failures resolve to
"AI analysis temporarily unavailable." while technicals keep working.

News module (`src/news/`): provider abstraction (empty default → honest
"No significant verified recent catalyst found."; HTTP backend optional),
https-only URLs required, relevance maps (OP→Optimism/Superchain…),
sentiment POSITIVE/NEGATIVE/NEUTRAL/UNCERTAIN (informational, never rescored),
dedupe + newest-first. Coin page shows headline/source/age/summary/sentiment
with safe external links; bounce rows show Catalyst: None/positive/negative.
Dashboard gains a deterministic AI MARKET REGIME (BTC/ETH/breadth/chop).

Security: no keys/tokens/secrets in code, `VITE_*`, `public/`, or history —
only endpoint URLs (see `.env.example`); audit grep clean.

- [x] Tests (mocked, 126 passing) + `npm run build` green (Phase 4 baseline)

## Phase 5 completed — full-market scanner + signal intelligence

- Scan engine (`src/scanner/`): eligibility gates (min $250k 24h volume, top-N
  universe 20/40/60, delisted excluded upstream), one bounded batch per coin
  (4 TF fetches, 8 concurrent), per-coin error isolation, honest counts
  (scanned / excluded with reasons / valid setups), breadth from scored signals.
- Setup types: BOUNCE (detector agreement) / BREAKOUT / BREAKDOWN
  (close-confirmed + non-weak volume) / PULLBACK / REVERSAL / TREND / RANGE.
- Bounce components displayed: support/25 momentum/35 volume/15 structure/5
  MTF/25. False breakouts surface as warnings, never auto-reversals.
- Quality: LOW/MEDIUM/HIGH from confluence + MTF + R:R + stop size +
  volatility + trap check. Core R:R gate: R:R < 1.5, stop > 4 ATR, or entry
  extended > 6 ATR → WAIT — POOR RISK/REWARD (never forced).
- Lifecycle: NEW → ACTIVE → STRENGTHENING/WEAKENING → INVALIDATED/COMPLETED
  (±5 strength moves, price-vs-invalidation/TP3 evidence, terminal states stick).
- Dedupe: stable `SYMBOL|DIR|TF|SETUP|anchorTs` IDs; new ID only on material change.
- Journal (`#/history`, localStorage): full setup record + lifecycle + outcome
  touches (TP1/2/3, invalidation, MFE/MAE in R, time-to-touch) + lazy AI summary.
- Notifications: in-app bell, NEW ≥ STRONG SETUP + material transitions only.
- Regime v2 (BULLISH/NEUTRAL/BEARISH + HIGH VOLATILITY flag, context only) and
  scanned-data breadth on Dashboard, coin pages, and scanner.
- Refresh control OFF/30s/1m/5m + universe size + setup-TF rescoring without
  refetch; stale feed pauses new scans; AI called only on coin pages.
- `ScanProvider` at app root: ONE scan feeds Scanner/Bounce/Dashboard/History.

- [x] Tests (mocked, 154 passing) + `npm run build` green (Phase 5 baseline)

## Phase 6 completed — backtesting + paper trading (simulation only)

- Backtest (`src/backtest/`): replay of historical `candleSnapshot` ranges
  through the EXACT live engine (`buildSignal` on strictly historical prefixes;
  higher TFs resampled without future data; trailing 400-bar window).
- Same-candle rule: a bar touching stop AND target exits the STOP first
  (conservative, documented in UI). Entry fills at next-bar open + slippage.
  Thirds scale-out at TP1/2/3; remainder stops or expires at range end.
- Costs: configurable fee (default 5 bps/side) + slippage (default 0.05%/side),
  both printed on every result. Funding via `fundingHistory` applied while
  open; labeled unavailable when absent — never fabricated.
- Sizing: risk% × balance / stop distance → size/notional/margin; leverage
  scales margin/exposure only, never the edge. One position at a time.
- Metrics: trades, wins/losses, win rate, avg/median R, profit factor, net PnL,
  return %, max DD + %, avg/best/worst, avg hold, TP1/2/3 + invalidation rates;
  equity + drawdown Recharts; sortable/filterable trade table; breakdowns by
  strength/setup/direction; IN-SAMPLE vs OUT-OF-SAMPLE labels; 30d/7d rolling
  walk-forward; multi-symbol compare (BTC/ETH/OP…).
- Look-ahead tripwires: resample purity + prefix identity + full-vs-truncated
  replay agreement tests that fail on any future read.
- Paper (`src/paper/` + `#/paper`): $1000/1% account, TAKE PAPER TRADE from
  coin signals with confirmation (fills at live mark), OPEN→TP1/2/3→STOPPED/
  CLOSED lifecycle on live ticks, manual close, AUTO PAPER TRADING toggle
  (sim only), position chart with Entry/SL/TP overlays, history filters,
  performance incl. TP rates, two-step RESET, localStorage persistence with a
  replaceable storage interface. No keys/credentials requested or stored.

- [x] Tests (mocked, 168 passing) + `npm run build` green (Phase 6 baseline)

## Phase 7 completed — monitoring + alerts (no trading touch)

- Monitor (`src/alerts/`): the shared scan IS the monitor — one cadence
  (OFF/30s/1m/5m, default 1m) feeds Scanner/Bounce/Dashboard/History/Alerts.
  No duplicate connections, no per-page feeds, no AI/news in the alert path.
- Events: NEW_SIGNAL, STRENGTHENED/WEAKENED (±5 lifecycle moves), INVALIDATED,
  TARGET_REACHED (TP1/2/3), ENTRY_REACHED, BOUNCE/BREAKOUT_DETECTED — each with
  a stable `signalId::type[:level]` ID; repeats collapse, never re-alert.
- Alert Center (`#/alerts`): NEW/ACTIVE/READ counts, full plan columns,
  coin/direction/event/date filters, mark-as-read, persisted history (200 cap).
- Providers: browser notifications (permission asked ONLY on enable, click
  opens `#/coin/SYM`), WebAudio sound beep (off unless enabled), Telegram
  architecture (message template per spec, `Not configured` without a backend
  endpoint, token never in frontend). In-app bell with unread count included.
- Filters: strength 60/70/80/90, LONG/SHORT/BOTH, setup set, TF set,
  watchlist-only. Watchlist (`#/watchlist`): pinned coins flagged ★ and
  prioritized; global scanner unaffected.
- Signal detail = coin page + timeline (created/strengthened/entry/TPs/
  weakened/invalidated — only occurred events) + AI + news + past outcomes.
- Targets on live mid ticks (wicks may pass between ticks — candle ranges in
  the journal stay the conservative record); expiry at 24h or sub-40 strength.
- Offline: MARKET DATA OFFLINE banner, scans paused, zero stale alerts, fresh
  scan on reconnect without replaying history (persisted seen-IDs).
- AI/news failures: monitor never calls them; coin sections degrade to their
  honest unavailable states while alerts continue.

- [x] Tests (mocked, 185 passing) + `npm run build` green (Phase 7 baseline)

## Phase 8 completed — rate limits + performance (fetch layer only)

Why 429s happened (audited, documented in code): the scanner fanned out
~160 candle POSTs per run at concurrency 8 while `getMarkets` fired ~11
parallel per-dex POSTs with no bound; every 30s snapshot poll bypassed the
cache; candle cache keys embedded `Date.now()` so entries NEVER hit across
components; every candle sub re-sent on connect (double-subscribe); hidden
tabs kept polling; and no retry logic existed despite the error text.

- Bounded everything: per-dex fan-out capped at 4 (order-preserving),
  scanner concurrency 8 → 6, candle subs send once (live socket or
  reconnect-replay, never both).
- Shared cache that actually hits: timeframe-grid-aligned candle keys
  (Scanner/Chart/Signal/Coin/History share one entry), TTLs 45s markets /
  30s candles, hit/miss counters; concurrent duplicates still coalesce.
- Real retry: `postInfoWithRetry` — exponential backoff (500ms×2, ±25%
  jitter, 8s ceiling, 4 retries max) for network/timeout/429/5xx only;
  missing-market/candles, cancellations and malformed shapes never retry.
- Visibility: hidden tabs skip all polling loops and resume with one
  refresh on return; the socket (cheap server push) stays connected.
- Status: 🟢 LIVE / 🟡 RECONNECTING / 🟠 RATE LIMITED (with retry countdown)
  / 🔴 OFFLINE alongside the existing states; no stack traces for users.
- Dev-only diagnostics panel (footer, `import.meta.env.DEV`): REST/min,
  sockets, cache hits/misses/rate, 429 count, subscriptions.

- [x] Tests (mocked, 211 passing) + `npm run build` green

## Hyperliquid data sources (public only)

REST `POST https://api.hyperliquid.xyz/info`:

| Use | Request | Response fields used |
|---|---|---|
| Dex list | `{ type: "perpDexs" }` | `[null, {name}, …]` → main + HIP-3 dexes (cached 10 min) |
| Universe + context (per dex) | `{ type: "metaAndAssetCtxs" [, dex] }` | `universe[].name`, `markPx, oraclePx, midPx, prevDayPx, dayNtlVlm, funding, openInterest` |
| Mid refresh | `{ type: "allMids" }` | `Record<symbol, midString>` (main dex) |
| Candles | `{ type: "candleSnapshot", req: { coin, interval, startTime, endTime } }` | `t,T,s,i,o,h,l,c,v,n` (HIP-3 coins use `dex:COIN`) |

WebSocket `wss://api.hyperliquid.xyz/ws`:

| Subscription | Channel | Purpose |
|---|---|---|
| `{ type: "allMids" }` | `allMids` → `{ mids }` | live mid ticks merged into snapshot |
| `{ type: "candle", coin, interval }` | `candle` → `Candle[]` | live forming-candle merges (coin page only) |

## Supported timeframes

`1m, 5m, 15m, 1h, 4h` — mapped 1:1 to Hyperliquid intervals. History window: last 300 candles.

## Market-data architecture

```
src/market/             # store (cached polls, 429 + socket states),
                      # visibility (hidden-tab gating), diagnostics
                      # (dev counters), hyperliquid/{client+retry, cache
                      # keys, bounded fan-out, single shared ws}
  hyperliquid/
    types.ts          # Market/Candle/Ticker/Funding/OpenInterest/MarketData/Timeframe + raw shapes + HyperliquidError
    client.ts         # postInfo() + postInfoWithRetry() — backoff/jitter/caps
    timeframes.ts     # SUPPORTED_TIMEFRAMES, toHyperliquidInterval, timeframeToMs, getCandleWindow
    markets.ts        # normalizeMetaAndAssetCtxs, normalizePerpDexs, mergeDexMarkets, normalizeAllMids, mergeLivePrices, findMarket
    candles.ts        # normalizeCandle(s), getCandles(), getRecentCandles(), getCachedCandles()
    funding.ts        # toFunding, formatFundingRate
    openInterest.ts   # toOpenInterest, formatOpenInterestNotional
    index.ts          # getMarkets() (bounded per-dex fan-out), getAllMids(), getCachedCandles() (grid keys)
    realtime.ts       # startMarketRealtime() — WS first, HTTPS polling fallback, visibility-gated
    __tests__/       # markets/candles/timeframes/client/retry/cachekeys (mocked fetch)
  cache.ts            # cached(key, ttl, fetcher) — dedupe, TTL, hit/miss stats
  persist.ts          # localStorage last-good snapshot — instant stale paint offline
  connection.ts       # 6-state machine + RATE LIMITED override + legacy mapping
  visibility.ts       # hidden-tab polling gates + return-to-tab refresh
  diagnostics.ts      # dev-only traffic counters (no production UI)
  freshness.ts        # FRESHNESS thresholds, isStale, formatLastUpdated
  ws.ts               # singleton WsManager — 1 socket, multiplexed subs, backoff, heartbeat, socket state
  store.tsx           # MarketDataProvider + useMarkets() — cached 30s poll, 429/socket states, visibility
  useCandles.ts       # useCandles(symbol, tf) — REST + WS merge + visibility-gated fallback
  __tests__/          # freshness, cache, persist, connection, visibility, diagnostics, ws, shared, rateLimit
src/components/
  LiveBadge.tsx       # legacy data-availability badges (kept for page headers)
  ConnectionBadge.tsx # 🟢/🟡/🟠/🔴 badge + last-update line (topbar, Bounce)
  CandleChart.tsx     # lightweight SVG candlesticks (full 300-candle window)
src/indicators/       # local OHLCV math: ema, rsi, macd, atr, volume (+ index)
  __tests__/          # hand-checked known values (EMA seed, Wilder RSI, TR, relVol)
src/analysis/         # deterministic engine: trend, momentum, volumeProfile,
                      # swings, levels, structure (+efficiencyRatio), mtf,
                      # bounce, scoring, tradeplan, signal, describe, hooks
  __tests__/          # scenario generators (bull/bear/chop/V-recovery/
                      # false-breakout/wick-rejection/dead-floor/insufficient)
src/ai/                # analyst: types, prompts, validate, input, cache,
                      # ratelimit, analyst (orchestrator), regime,
                      # providers/{localExplainer,httpProvider}, useAiAnalysis
  __tests__/          # input gen, response validation, override rejection,
                      # cache, throttle/dedupe, fallback, regime
src/news/             # types, relevance maps, provider (empty/http),
                      # aggregator, useNews/useNewsBatch
  __tests__/          # normalization, relevance, sentiment, ordering
src/signals/          # setupType (+stable IDs), lifecycle, outcomes (R),
                      # quality (+R:R/extension gates), journal, notifications
  __tests__/          # state machine, dedupe, outcomes, quality, journal, bell
src/scanner/          # eligibility, engine (bounded full-market scan),
                      # ScanContext (shared results, refresh, journal+alerts)
  __tests__/          # filtering, ranking, breadth, isolation (mocked fetch)
src/backtest/         # types, data (chunked history + funding), simulation
                      # (prefix replay, thirds exits, costs), metrics, engine
                      # (train/test, walk-forward, multi-symbol)
  __tests__/          # sizing, LONG/SHORT, TP/SL, conflict rule, fees,
                      # slippage, funding, metrics, look-ahead tripwires
src/paper/            # types, portfolio (pure lifecycle math), engine
                      # (account, persistence, auto-sim), singleton
  __tests__/          # lifecycle, engine accounting, secret-free persistence
src/alerts/           # events (stable IDs), settings (persisted filters),
                      # watchlist, providers (browser/sound/telegram-arch),
                      # store (persisted history, fan-out), monitor (pure
                      # scan/target evaluation), targets (tick checks), expiry
  __tests__/          # detection, dedupe, transitions, TP/entry/invalidation,
                      # expiry, permission silence, filters, watchlist, offline
```

Rules: UI never touches `fetch` or raw shapes — only `useMarkets()`, `useCandles()`, `getMarkets()`, `getCandles()`, formatters.

## Development

```bash
npm install
npm test        # vitest run — 211 mocked unit tests
npm run build   # tsc -b && vite build
npm run dev     # http://localhost:5173
```

Verify: `#/scanner` (filters, 6 sorts, refresh modes, stale pause) → `#/bounce` (components, catalysts) → `#/history` (lifecycle, outcome refresh) → `#/coin/OP` (state chip, components, regime/breadth, outcomes, AI, news) → bell notifications on new ≥75 setups → kill subsystems one by one (AI/news/coin/API) for isolation.

## Pages

- `/` Dashboard — regime + breadth + high-confluence longs/shorts + bounce/breakout strips + recent signals + data status
- `/scanner` — HIGH-CONFLUENCE SETUPS over the eligible universe: 13 columns, direction/setup/strength/volume filters, 6 sorts (default Strength ↓), refresh + universe + TF controls
- `/coin/:symbol` — signal state chip, setup type, component bars, regime/breadth context, past outcomes, timeline, AI + news + history link, TAKE PAPER TRADE
- `/bounce` — full-universe bounce scan with bounce-score components + catalyst column
- `/alerts` — NEW/ACTIVE/READ event history with plan columns and filters
- `/watchlist` — pinned coins with live prices and latest setups
- `/history` — journal with lifecycle filters (incl. EXPIRED), outcome touches, refresh-outcomes (bounded), clear
- `/backtest` — config (symbol/TF/dates/balance/risk/fee/slippage/leverage/train-test/walk-forward, multi-symbol compare), metrics, equity/drawdown charts, sortable trade table, strength/setup breakdowns
- `/paper` — PAPER/SIMULATION banners, account config, auto-toggle, open positions with live R, position chart overlays, history filters, performance, two-step reset
- `/settings` — unchanged shell (out of scope)

## Known limitations

- Chunk-size warning (>500kB, Recharts) — pre-existing, no code-split in this phase.
- WS `allMids` streams main-dex mids; HIP-3 rows refresh on the 30s snapshot poll.
- `allPerpMetas` intentionally unused: live shape carries no asset contexts — per-dex `metaAndAssetCtxs` is the reliable source.
- GitHub Pages edge caching can serve the previous bundle for a few minutes after a deploy; the Actions run status is the source of truth.
