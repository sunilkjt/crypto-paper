// Supabase Edge Function: explain-signal (Deno).
//
// Secure Gemini backend for the Crypto-Paper frontend. The browser NEVER holds
// the Gemini key: it POSTs only engine-produced signal facts, and this
// function calls Google with GEMINI_API_KEY from the server environment.
//
// Wire protocol (matches the frontend HttpAiProvider exactly):
//   POST { system: string, user: string, input: AiAnalysisInput }
//   -> 200 { analysis: { summary, marketStructure, setup, confirmations,
//                       conflicts, risks, invalidation, catalysts,
//                       conclusion, directionEcho } }
//   -> 4xx/5xx { error: string } on any failure (frontend falls back to the
//      deterministic local explainer — never a broken page).
//
// Deploy (from repo root, Supabase CLI logged in):
//   supabase functions deploy explain-signal
//   supabase secrets set GEMINI_API_KEY=<key>   # server-side ONLY, never VITE_*
// Frontend: VITE_AI_ENDPOINT=https://<ref>.supabase.co/functions/v1/explain-signal

const GEMINI_MODEL = "gemini-3.5-flash-lite";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const UPSTREAM_TIMEOUT_MS = 20_000;
const MAX_BODY_BYTES = 131_072;
const MAX_STR = 2000;

const DIRECTIONS = new Set(["LONG", "SHORT", "WAIT"]);

const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    summary: { type: "STRING" },
    marketStructure: { type: "STRING" },
    setup: { type: "STRING" },
    confirmations: { type: "ARRAY", items: { type: "STRING" } },
    conflicts: { type: "ARRAY", items: { type: "STRING" } },
    risks: { type: "ARRAY", items: { type: "STRING" } },
    invalidation: { type: "STRING" },
    catalysts: { type: "ARRAY", items: { type: "STRING" } },
    conclusion: { type: "STRING" },
    directionEcho: { type: "STRING", enum: ["LONG", "SHORT", "WAIT"] },
  },
  required: [
    "summary",
    "marketStructure",
    "setup",
    "confirmations",
    "conflicts",
    "risks",
    "invalidation",
    "catalysts",
    "conclusion",
    "directionEcho",
  ],
};

// NOTE: "catalysts" arrives from older clients as an array; normalize to text.
function clip(v: unknown): string {
  return typeof v === "string" ? v.slice(0, MAX_STR) : "";
}

function clipList(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x) => typeof x === "string").map((x) => (x as string).slice(0, 1000));
  if (typeof v === "string" && v.length > 0) return [v.slice(0, 1000)];
  return [];
}

function corsHeaders(origin: string | null): Record<string, string> {
  const allowed = (Deno.env.get("ALLOWED_ORIGINS") ?? "*")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const allow = allowed.includes("*") || (origin !== null && allowed.includes(origin)) ? "*" : "null";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
    "Content-Type": "application/json",
  };
}

function json(headers: Record<string, string>, status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

Deno.serve(async (req: Request): Promise<Response> => {
  const headers = corsHeaders(req.headers.get("Origin"));
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers });
  }
  if (req.method !== "POST") {
    return json(headers, 405, { error: "Method not allowed." });
  }

  const apiKey = Deno.env.get("GEMINI_API_KEY") ?? "";
  if (apiKey === "") {
    return json(headers, 503, { error: "AI backend not configured." });
  }

  let body: unknown;
  try {
    const text = await req.text();
    if (text.length > MAX_BODY_BYTES) {
      return json(headers, 413, { error: "Request too large." });
    }
    body = JSON.parse(text) as unknown;
  } catch {
    return json(headers, 400, { error: "Invalid JSON body." });
  }
  const payload = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const input = (typeof payload.input === "object" && payload.input !== null ? payload.input : {}) as Record<string, unknown>;
  const direction = typeof input.signalDirection === "string" ? input.signalDirection : "";
  const symbol = typeof input.symbol === "string" ? input.symbol.toUpperCase().slice(0, 12) : "UNKNOWN";
  if (!DIRECTIONS.has(direction)) {
    return json(headers, 400, { error: "Missing or invalid signalDirection." });
  }

  // Facts forwarded to Gemini are a compact projection of the engine input —
  // market/signal data only. The input schema carries no credentials at all.
  const facts = [
    `symbol=${symbol} direction=${direction} strength=${Number(input.signalStrength) || 0}`,
    `plan: ${String(payload.user ?? "").slice(0, 4000)}`,
  ].join("\n");

  const systemInstruction = [
    "You are a concise crypto market signal explainer. You are NOT the trading decision engine.",
    "The supplied signal was already calculated by a deterministic technical-analysis engine.",
    `Explain why the supplied signal was generated using ONLY the supplied data. Signal direction is ${direction} — repeat it exactly, never change it.`,
    "Do not invent indicators, prices, news, catalysts or market conditions.",
    "Do not recommend different entry, stop-loss or take-profit levels.",
    "Do not provide guaranteed outcomes. Strength is confluence, never probability.",
    (typeof payload.system === "string" && payload.system.length > 0
      ? `Additional project rules: ${payload.system.slice(0, 2000)}`
      : ""),
    "Keep summary to 1-3 sentences. Return ONLY the requested JSON shape.",
  ]
    .filter(Boolean)
    .join("\n");

  let upstream: Response;
  try {
    upstream = await fetch(`${GEMINI_URL}?key=${encodeURIComponent(apiKey)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemInstruction }] },
        contents: [{ role: "user", parts: [{ text: facts }] }],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: RESPONSE_SCHEMA,
          maxOutputTokens: 600,
          temperature: 0.2,
        },
      }),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch {
    return json(headers, 503, { error: "AI provider unreachable." });
  }

  if (upstream.status === 429) {
    return json(headers, 429, { error: "AI rate limit reached — try again shortly." });
  }
  if (!upstream.ok) {
    // Surface Google's real reason (status + message) so key/project issues
    // are diagnosable. Never echoes the request URL, so the key can't leak.
    let detail = "";
    try {
      detail = (await upstream.text()).slice(0, 300);
    } catch {
      // ignore body read failures
    }
    return json(headers, 502, { error: `AI provider error (HTTP ${upstream.status}). ${detail}`.slice(0, 500) });
  }

  let parsed: Record<string, unknown>;
  try {
    const data = (await upstream.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return json(headers, 502, { error: "AI returned an unusable response." });
  }

  if (typeof parsed.summary !== "string" || parsed.summary.length === 0) {
    return json(headers, 502, { error: "AI returned an incomplete response." });
  }

  // Server-side direction lock: the engine direction wins even if the model
  // drifts. The frontend validator enforces this a second time.
  return json(headers, 200, {
    analysis: {
      summary: clip(parsed.summary),
      marketStructure: clip(parsed.marketStructure),
      setup: clip(parsed.setup),
      confirmations: clipList(parsed.confirmations),
      conflicts: clipList(parsed.conflicts),
      risks: clipList(parsed.risks),
      invalidation: clip(parsed.invalidation),
      catalysts: clipList(parsed.catalysts),
      conclusion: clip(parsed.conclusion),
      directionEcho: direction,
      provider: "gemini-edge",
    },
  });
});
