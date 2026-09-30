-- Server-side signal history for the 24/7 cron + Telegram pull commands.
-- Why a new table (not a migration for its own sake): no server-side signal
-- store exists today. Browser journals are per-device localStorage and cron
-- seens hold only id/strength/status — neither carries entry/SL/TP/score in
-- queryable form. The Telegram bot must answer /signals /today /last
-- /history from the database without triggering scans or AI calls.
--
-- Written by the headless cron only (service role). Read by the Telegram
-- webhook (service role). No user-facing API reads this table.

create table if not exists public.signal_history (
  id text primary key,
  category text not null check (category in ('crypto', 'stocks', 'commodities')),
  symbol text not null,
  direction text not null check (direction in ('LONG', 'SHORT')),
  score integer not null,
  timeframe text not null,
  entry_low double precision,
  entry_high double precision,
  invalidation double precision,
  tp1 double precision,
  tp2 double precision,
  tp3 double precision,
  risk_reward double precision,
  setup_type text,
  status text not null default 'NEW',
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists signal_history_last_seen_idx
  on public.signal_history (last_seen desc);
create index if not exists signal_history_category_time_idx
  on public.signal_history (category, last_seen desc);
create index if not exists signal_history_symbol_time_idx
  on public.signal_history (symbol, last_seen desc);

alter table public.signal_history enable row level security;
-- Intentionally no policies: service_role (cron writer + bot reader)
-- bypasses RLS; anon/authenticated API callers are denied.
