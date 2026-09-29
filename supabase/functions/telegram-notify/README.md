# telegram-notify — delivery endpoint (authenticated)

Gateway JWT verification stays ON. Reads only the caller's own connection
row (RLS); the chat_id always comes from storage, never the browser.
Plain-text sendMessage + optional View Analysis button. Test mode sends a
connection template, never a real signal.

```bash
supabase functions deploy telegram-notify
supabase secrets set TELEGRAM_BOT_TOKEN=<token>
```
