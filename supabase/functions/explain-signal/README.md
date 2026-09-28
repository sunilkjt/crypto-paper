# explain-signal — Gemini backend for AI explanations

The browser never holds the Gemini key. The frontend POSTs engine-produced
signal facts to this function; the function calls Gemini with the server-side
`GEMINI_API_KEY` and returns validated explanation JSON.

## Deploy

```bash
supabase functions deploy explain-signal
supabase secrets set GEMINI_API_KEY=<your-gemini-key>
```

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
