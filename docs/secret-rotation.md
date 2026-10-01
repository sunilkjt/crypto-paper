# Secret rotation runbook

All provider/bot keys live server-side only. Nothing below ever touches
frontend code, `VITE_*` variables, git, or chat logs. After ANY rotation,
verify with the check at the bottom.

## 1. Supabase service-role key

Used by: GitHub Actions cron + watchdog (server-to-server REST only).

1. Supabase → Project Settings → API → generate a new `service_role` key
   (revoking the old one signs out nothing — it is not a user session).
2. GitHub → repo → Settings → Secrets → Actions → update
   `SUPABASE_SERVICE_ROLE_KEY`.
3. No rebuild needed (workflows read secrets at run time). Trigger
   "Paper signal cron" manually once and confirm green.

## 2. Telegram bot token

Used by: `telegram-webhook`, `telegram-notify` edge functions (server
environment) and the CI cron/watchdog jobs.

1. BotFather → `/mybots` → your bot → **API Token → Revoke current token**
   → copy the new token.
2. Supabase → Project Settings → Secrets (or Edge Functions → Secrets):
   update `TELEGRAM_BOT_TOKEN`. Redeploy is NOT needed for secret-only
   changes (functions read env at invocation).
3. GitHub → repo Secrets → update `TELEGRAM_BOT_TOKEN` (cron jobs).
4. Verify: Settings → Telegram Pairing → Send Test Telegram → message
   arrives. (Old pairings keep working — chat IDs don't change.)

## 3. Groq / Gemini provider keys

Used by: `explain-signal` edge function only.

1. Provider dashboard → roll the key.
2. Supabase → Secrets → update `GROQ_API_KEY` / `GEMINI_API_KEY`.
3. Verify: scanner card → ✨ AI Explanation → fresh (non-cached) summary.

## 4. GitHub Actions secrets inventory (all server-side)

- `SUPABASE_URL` — public project URL (not sensitive, but kept uniform)
- `SUPABASE_SERVICE_ROLE_KEY` — rotation: section 1
- `TELEGRAM_BOT_TOKEN` — rotation: section 2
- `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`,
  `VITE_AI_ENDPOINT`, `VITE_TELEGRAM_ENDPOINT` — publishable endpoints
  only; safe in the frontend bundle by design.

## 5. Supabase function secrets inventory

- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME` (link/notify/webhook)
- `GEMINI_API_KEY`, `GROQ_API_KEY`, `AI_PROVIDER`, `GROQ_MODEL`,
  `ALLOWED_ORIGINS` (explain-signal)
- `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
  (auto-provided by Supabase — never set manually)

## Verification after any rotation

- `npm run supabase:doctor` (needs the NEW service key in env) — all PASS
- Manual "Paper signal cron" run — green, sane report counts
- Telegram test message arrives
- Never paste a secret into chat, issues, logs, or frontend files. If one
  leaks, revoke it first (BotFather / provider dashboard), then rotate
  everywhere above.
