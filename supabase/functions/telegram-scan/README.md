# telegram-scan — Manual on-demand market scan (Deno)

Runs a **fresh** Hyperliquid scan when a paired user sends `/scan ...` in
Telegram. Uses the **exact deterministic engine** as the 24/7 cron
(`getMarkets` + `runFullScan` + scoring from `src/`), but is strictly
read-only:

- NO cron state reads/writes (scheduled scanner untouched)
- NO `signal_history` writes (never fabricates scheduled-signal rows)
- NO notification cooldown/fingerprint gate (the user explicitly asked)
- NO AI (the engine decides everything, as always)

Flow: `telegram-webhook` verifies pairing → sends `🔎 Scanning...` ack →
invokes this function (service-role, server-to-server) → this function
re-validates pairing → scans → edits the ack with chunk 1 → sends the rest.

Commands: `/scan`, `/scan crypto|stocks|commodities`,
`/scan long|short`, `/scan trade`, `/scan 5|10|20`, combined
(e.g. `/scan stocks long`, `/scan crypto 5`, `/scan trade 10`).
Case-insensitive. Default top 10, max 20. Unknown tokens ignored.

Rate protection: per-chat concurrency guard, bounded scan concurrency (5),
Hyperliquid retry/backoff reuse, per-coin and per-category isolation, 140s
deadline with honest partial results. Failures map to
`SCAN_FAILED_MESSAGE` — stale data is never presented as fresh.

## Files

- `handler.src.ts` — handwritten handler (edit this)
- `index.ts` — GENERATED single-file bundle (edit never; deploys)

Regenerate after any `src/` engine or handler change:

```bash
npm run bundle:scan
```

## Deploy

```bash
supabase functions deploy telegram-scan
```

Gateway JWT verification: this function requires
`Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>` (server-to-server
only — never call it from the browser).

Secrets (server-side only, never in code):
`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `TELEGRAM_BOT_TOKEN`.
