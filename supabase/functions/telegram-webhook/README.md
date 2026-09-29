# telegram-webhook — Bot API receiver (no user JWT)

Gateway JWT verification must be OFF for this function (Telegram servers
call it). Security comes from one-time `/start <token>` payloads: unknown
or reused tokens are ignored with HTTP 200. Uses the service role
server-side; the bot token never leaves the server.

```bash
supabase functions deploy telegram-webhook
# then: Dashboard → Edge Functions → telegram-webhook → disable JWT verification
```
