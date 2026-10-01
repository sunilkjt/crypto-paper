-- Website reads of server-side scanner data (History cloud mode, dashboard
-- health panel). Signals and cooldown fingerprints derive exclusively from
-- PUBLIC Hyperliquid market data — they contain no PII, balances, keys, or
-- user content — so authenticated SELECT is safe. Service-role writers are
-- unaffected (bypass RLS). Anonymous callers remain denied everywhere.

drop policy if exists signal_history_owner_select on public.signal_history;
create policy signal_history_owner_select on public.signal_history
  for select using (auth.uid() is not null);

drop policy if exists scanner_state_owner_select on public.scanner_state;
create policy scanner_state_owner_select on public.scanner_state
  for select using (auth.uid() is not null);
