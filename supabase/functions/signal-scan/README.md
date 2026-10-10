# signal-scan — Scheduled 5-minute scanner (Deno)

Supabase-native 24/7 trigger. Runs the **full** headless cron pipeline —
the same deterministic engine as `scripts/scan-cron.ts`:

- market discovery → per-category `runFullScan` → lifecycle transitions vs
  persisted state → cooldown-gated Telegram delivery → state save +
  `signal_history` upsert + heartbeat
- Reads/writes `scanner_state` (`cron-monitor`), writes `signal_history`,
  claims notification fingerprints, delivers to all enabled
  `telegram_connections` chats
- No AI, no trades, no journal writes

This is **not** `telegram-scan`. That function is a read-only manual
`/scan` endpoint (no state, no history, no broadcast) — putting it on a
timer would deliver nothing. This function **is** the scheduled scanner.

## Files

- `handler.src.ts` — handwritten handler (edit this)
- `index.ts` — GENERATED single-file bundle (edit never; deploys)

Regenerate after any `src/` engine or handler change:

```bash
npm run bundle:signal-scan
```

## Deploy

```bash
supabase functions deploy signal-scan
supabase secrets set TELEGRAM_BOT_TOKEN=<token> SITE_URL=https://sunilkjt.github.io/crypto-paper
# SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are always present in functions.
```

Gateway JWT verification: this function requires
`Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>` (server-to-server
only — never call it from the browser).

Optional env (same defaults as the old GitHub cron):
`SCAN_CATEGORIES=crypto,stocks,commodities`, `NOTIFY_MIN_STRENGTH=70`,
`NOTIFY_DIRECTIONS=LONG,SHORT`, `NOTIFY_COOLDOWN_MINUTES=30`,
`UNIVERSE_CAP=60`, `SCAN_CONCURRENCY=5`.

## Schedule (primary trigger)

Migration `0010_signal_cron.sql` enables `pg_cron` + `pg_net` and
schedules `signal-scan-5min` (`*/5 * * * *`). After deploying, store the
service key in the vault and point the job at it (see the migration
header) — then disable the GitHub `scan-cron` schedule (kept as a manual
`workflow_dispatch` fallback only) so exactly one scanner runs.

Manual run (service key never leaves the server):

```bash
curl -X POST https://<ref>.supabase.co/functions/v1/signal-scan \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -d '{}'
```

`{"dry_run": true}` runs the full scan + state/history writes are skipped
for history and delivery counts as zero (lifecycle state still advances —
use only for smoke tests). A concurrent tick returns
`202 {accepted:false, reason:"busy"}`; the atomic claim gate makes
overlaps safe anyway.
