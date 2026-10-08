-- Signal activation + ambiguity tracking for realistic performance
-- analytics (additive only).
--
-- Why: v1 outcomes measured TP/SL from the signal bar even for RETEST
-- signals whose entry zone was never touched. These columns record how a
-- signal activated (or didn't) without rewriting any original signal
-- field (direction/score/entry/SL/TP/reasons/timestamps stay immutable).
--
-- - entry_type: MARKET (price inside the zone at signal time) or RETEST.
--   Legacy rows stay NULL and measure exactly as before (no retroactive
--   methodology change).
-- - activation_price/_at: entry-mid estimate at the activating candle.
--   Always an estimate (OHLC cannot prove a fill) — analytics labels it.
-- - ambiguous: true when a same-bar stop/target conflict fell back to the
--   conservative rule (reported separately, never hidden).
-- - outcome gains NO_FILL (lifetime passed, zone never touched) and
--   INVALIDATED (stop touched before activation — not a loss, no fill).
-- Idempotent and non-destructive.

alter table if exists public.signal_history
  add column if not exists entry_type text check (entry_type in ('MARKET', 'RETEST')),
  add column if not exists activation_price double precision,
  add column if not exists activation_at timestamptz,
  add column if not exists ambiguous boolean not null default false;

alter table if exists public.signal_history
  drop constraint if exists signal_history_outcome_check;

alter table if exists public.signal_history
  add constraint signal_history_outcome_check
  check (outcome in ('WIN', 'LOSS', 'BREAKEVEN', 'EXPIRED', 'OPEN', 'UNKNOWN', 'NO_FILL', 'INVALIDATED'));
