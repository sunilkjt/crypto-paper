/**
 * Safe diagnostics for signal-quality database reads.
 *
 * Pure helpers only: no fetch, no secrets, no strategy math. Every
 * formatter takes an explicit operation name + REST path + status/body
 * snapshot and returns a log-safe string. Sensitive material (API keys,
 * tokens, Authorization headers, JWTs, sb_secret_* values) is redacted
 * even if a backend ever echoes it inside an error payload.
 */

export interface RestSnapshot {
  status: number;
  json: unknown;
  contentRange: string | null;
}

export interface PostgrestError {
  code: string | null;
  message: string | null;
  hint: string | null;
  details: string | null;
}

const MAX_FIELD = 300;
const MAX_TOTAL = 900;

function asTrimmedString(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** Parse a PostgREST Content-Range header (`0-0/123`, `*\/0`) to its total. */
export function parseCount(contentRange: string | null): number | null {
  if (!contentRange) return null;
  const m = /\/(\d+)\s*$/.exec(contentRange);
  return m ? Number.parseInt(m[1], 10) : null;
}

/** Extract PostgREST error fields when the body carries them, else nulls. */
export function extractPostgrestError(json: unknown): PostgrestError {
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    return { code: null, message: null, hint: null, details: null };
  }
  const o = json as Record<string, unknown>;
  return {
    code: asTrimmedString(o.code),
    message: asTrimmedString(o.message),
    hint: asTrimmedString(o.hint),
    details: asTrimmedString(o.details),
  };
}

/**
 * Redact anything that looks like a credential, even inside free-form
 * backend messages. Paths and PostgREST messages never contain secrets,
 * but redaction keeps future callers safe by construction.
 */
export function redactSensitiveText(input: string): string {
  return input
    .replace(/apikey\s*[:=]\s*\S+/gi, "apikey=[redacted]")
    .replace(/authorization\s*[:=]\s*\S+(?:\s+\S+)?/gi, "authorization=[redacted]")
    .replace(/bearer\s+[A-Za-z0-9\-_.~+/=]+/gi, "bearer [redacted]")
    .replace(/sb_secret_[A-Za-z0-9\-_]+/g, "sb_secret_[redacted]")
    .replace(/sb_publishable_[A-Za-z0-9\-_]+/g, "sb_publishable_[redacted]")
    .replace(/eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[jwt-redacted]")
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[jwt-redacted]");
}

function summarizeBody(json: unknown): string {
  if (Array.isArray(json)) return `rows=${json.length}`;
  if (typeof json === "object" && json !== null) {
    const err = extractPostgrestError(json);
    if (err.message ?? err.code ?? err.hint ?? err.details) return "object-error";
    const keys = Object.keys(json as Record<string, unknown>).slice(0, 5).join(",");
    return `object{${keys}}`;
  }
  if (json === null) return "empty-body";
  return typeof json;
}

/**
 * One-line, log-safe description of a non-OK (or unexpected-shape) REST
 * response. Includes HTTP status, PostgREST code/message/hint/details,
 * the operation + query path, Content-Range, and body shape — never
 * headers, keys, or tokens.
 */
export function formatRestFailure(op: string, path: string, res: RestSnapshot): string {
  const err = extractPostgrestError(res.json);
  const parts = [
    `${op} failed`,
    `(HTTP ${res.status}`,
    `code=${err.code ?? "n/a"}`,
    `message=${truncate(err.message ?? "n/a", MAX_FIELD)}`,
    `hint=${truncate(err.hint ?? "n/a", MAX_FIELD)}`,
    `details=${truncate(err.details ?? "n/a", MAX_FIELD)})`,
    `query=${path}`,
    `content-range=${res.contentRange ?? "none"}`,
    `body=${summarizeBody(res.json)}`,
  ];
  return truncate(redactSensitiveText(parts.join(" ")), MAX_TOTAL);
}

/** Log-safe description of a fetch-level throw (timeout, DNS, abort). */
export function formatNetworkFailure(op: string, path: string, err: unknown): string {
  const raw = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  const clean = truncate(raw.trim() === "" ? "unknown network error" : raw, MAX_FIELD);
  return truncate(redactSensitiveText(`${op} failed (network: ${clean}) query=${path}`), MAX_TOTAL);
}

/**
 * Require an exact-count query to succeed. Returns the count.
 * Throws a formatted Error otherwise — callers must treat the throw as
 * DB_UNREADABLE, never as zero.
 *
 * Accepts HTTP 200 (complete) and 206 (Partial Content): PostgREST
 * returns 206 with a valid Content-Range total whenever the result set
 * is truncated by limit/max-rows, which is the normal case for
 * count=exact over a history larger than one page.
 */
export function requireCount(op: string, path: string, res: RestSnapshot): number {
  const n = parseCount(res.contentRange);
  if ((res.status === 200 || res.status === 206) && n !== null) return n;
  throw new Error(formatRestFailure(op, path, res));
}

/**
 * Require a row-list response with an array body. Accepts 200 and 206
 * (paged/truncated reads return 206 with a Content-Range).
 */
export function requireRows(op: string, path: string, res: RestSnapshot): unknown[] {
  if ((res.status === 200 || res.status === 206) && Array.isArray(res.json)) return res.json as unknown[];
  throw new Error(formatRestFailure(op, path, res));
}
