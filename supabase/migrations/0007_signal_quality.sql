-- Signal quality for server history rows (LOW/MEDIUM/HIGH QUALITY as
-- assessed by the scan engine at write time). Additive, nullable, no
-- backfill: pre-column rows read back with a neutral display default.
-- Idempotent and non-destructive.

alter table if exists public.signal_history
  add column if not exists quality text;
