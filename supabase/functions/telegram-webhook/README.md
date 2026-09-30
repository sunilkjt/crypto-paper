# telegram-webhook — Bot API receiver (no user JWT)

Gateway JWT verification must be OFF for this function (Telegram servers
call it). Two roles:

PAIRING (existing): `/start <one-time-token>` links the chat (tokens are
single-use, 15-min, validated server-side); `/stop` pauses. Unknown input
is ignored with HTTP 200 — no oracle for token probing.

COMMANDS (read-only, paired chats only): `/help /status /signals
[/signals crypto|stocks|commodities] /today /last [SYMBOL] /history [n]`
plus deterministic natural-language intents. Pure Supabase reads against
`signal_history` (+ `scanner_state` heartbeat for /status); never scans,
never calls Hyperliquid, Groq, or trading. Shared parsing/formatting lives
in `../_shared/commands.ts` (also unit-tested via vitest).

```bash
supabase functions deploy telegram-webhook
# then: Dashboard → Edge Functions → telegram-webhook → disable JWT verification
```
