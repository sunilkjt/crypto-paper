# telegram-link — pairing actions (authenticated)

Gateway JWT verification stays ON. All DB access is RLS-scoped to the caller.

Actions: `status`, `create-token` (also registers the Telegram webhook),
`disconnect`.

```bash
supabase functions deploy telegram-link
supabase secrets set TELEGRAM_BOT_TOKEN=<token> TELEGRAM_BOT_USERNAME=<name>
```
