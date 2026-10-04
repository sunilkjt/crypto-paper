# telegram-webhook — Bot API receiver (no user JWT)

Gateway JWT verification must be OFF for this function (Telegram servers
call it). Two roles:

PAIRING (existing): `/start <one-time-token>` links the chat (tokens are
single-use, 15-min, validated server-side); `/stop` pauses. Unknown input
is ignored with HTTP 200 — no oracle for token probing.

COMMANDS (read-only, paired chats only): `/help /status /signals
[/signals crypto|stocks|commodities] /today /last [SYMBOL] /history [n]
/scan [crypto|stocks|commodities] [long|short] [trade] [n]` plus
deterministic natural-language intents. Pure Supabase reads against
`signal_history` (+ `scanner_state` heartbeat for /status); `/scan`
acknowledges immediately and hands off to the `telegram-scan` function
(same deterministic engine, read-only: no history writes, no cooldown
gate); never calls Groq, or trading. Shared parsing/formatting lives
in `../_shared/commands.ts` (also unit-tested via vitest).

```bash
supabase functions deploy telegram-webhook
# then: Dashboard → Edge Functions → telegram-webhook → disable JWT verification
```
