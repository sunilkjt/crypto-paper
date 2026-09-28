# explain-signal — AI backend for signal explanations (Gemini or Groq)

The browser never holds any provider key. The frontend POSTs engine-produced
signal facts to this function; the function calls the configured provider
with a server-side key and returns validated explanation JSON.

## Deploy

```bash
supabase functions deploy explain-signal
```

## Provider: Gemini (default)

```bash
supabase secrets set GEMINI_API_KEY=<your-gemini-key>
```

## Provider: Groq (free tier, no billing card)

```bash
supabase secrets set AI_PROVIDER=groq GROQ_API_KEY=<your-groq-key>
```

Get a free key at https://console.groq.com (sign up → API Keys → Create).
Optional model override: `supabase secrets set GROQ_MODEL=<model>`.
To switch back: `supabase secrets set AI_PROVIDER=gemini`.

Optional: restrict browser origins (default allows all; no cookies involved):

```bash
supabase secrets set ALLOWED_ORIGINS=https://sunilkjt.github.io
```

## Frontend wiring

```env
VITE_AI_ENDPOINT=https://<project-ref>.supabase.co/functions/v1/explain-signal
```

For this project:

```env
VITE_AI_ENDPOINT=https://dzcwpaegqvhigceuxiop.supabase.co/functions/v1/explain-signal
```

Leave `VITE_AI_ENDPOINT` empty to use the built-in deterministic local
explainer (badged LOCAL · NOT AN LLM). Never create `VITE_GEMINI_API_KEY`.

## Protocol

`POST { system, user, input }` → `200 { analysis: { summary,
marketStructure, setup, confirmations, conflicts, risks, invalidation,
catalysts, conclusion, directionEcho } }` or `4xx/5xx { error }`.
The frontend validates direction-echo and falls back on any failure.
