-- Signal outcome tracking for performance analytics (additive only).
--
-- Why: signal_history records entries/SL/TPs but never what happened next.
-- A scheduled resolver job replays post-signal candles with the same
-- conservative thirds rules as paper trading (stop processed before targets
-- on the same bar) and writes the terminal verdict here. Analytics pages
-- and the Telegram /performance command then read precomputed outcomes —
-- no candle fetching in the UI, no recomputation in the bot.
--
-- Contract:
-- - Only rows with outcome IS NULL are ever resolved (resolved rows are
--   never rewritten → historical signals are immutable).
-- - OPEN is transient and never written (unresolved rows stay NULL until
--   they reach a terminal verdict).
-- - Pre-column rows read back with outcome NULL (treated as unprocessed).
-- - reasons is write-only context for future display; metrics never depend
--   on it.
-- Idempotent and non-destructive.

alter table if exists public.signal_history
  add column if not exists outcome text check (outcome in ('WIN', 'LOSS', 'BREAKEVEN', 'EXPIRED', 'OPEN', 'UNKNOWN')),
  add column if not exists outcome_at timestamptz,
  add column if not exists exit_price double precision,
  add column if not exists realized_r double precision,
  add column if not exists resolved_at timestamptz,
  add column if not exists decided_by text,
  add column if not exists reasons text[];

create index if not exists signal_history_outcome_idx
  on public.signal_history (outcome) where outcome is null;

create index if not exists signal_history_first_seen_idx
  on public.signal_history (first_seen desc);
