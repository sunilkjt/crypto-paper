-- Supabase-native 5-minute scanner trigger (replaces the GitHub Actions
-- schedule for the paper-signal cron).
--
-- Why: GitHub scheduled workflows are best-effort (throttled/delayed at
-- busy hours, auto-disabled after 60 days of repo inactivity) and every
-- tick pays a full checkout + npm ci before any scanning starts. pg_cron
-- runs inside Supabase's own infra and POSTs straight to the signal-scan
-- edge function, which bundles the exact same deterministic pipeline as
-- scripts/scan-cron.ts (state, claims, history, delivery, heartbeat).
--
-- IMPORTANT: scheduling telegram-scan on a timer would deliver NOTHING —
-- that function is a read-only manual /scan endpoint (no state, no
-- history, no broadcast). The scheduled target MUST be signal-scan.
--
-- What this migration does:
--   1. Enables pg_cron + pg_net (Supabase-supported extensions).
--   2. Schedules `signal-scan-5min` (*/5 * * * *) — but ONLY when the
--      vault secret `signal_scan_service_key` already exists, so
--      `supabase db push` never fails on a fresh checkout.
--
-- ONE-TIME SETUP (after `supabase functions deploy signal-scan`):
--
--   -- 1. Store the service_role key in the vault (Dashboard → SQL editor):
--   select vault.create_secret('<PASTE_SERVICE_ROLE_KEY>', 'signal_scan_service_key');
--
--   -- 2. Re-apply this migration (or re-run just the DO block below) so the
--   --    job is created now that the secret exists. Verify with:
--   select jobname, schedule, active from cron.job where jobname = 'signal-scan-5min';
--
--   -- 3. Disable the GitHub schedule (scan-cron.yml is manual-only now) so
--   --    exactly one scanner runs — the atomic claim gate would suppress
--   --    most duplicates, but two writers still churn state needlessly.
--
-- Pause/resume the schedule anytime without a deploy:
--   select cron.alter_job((select jobid from cron.job where jobname = 'signal-scan-5min'), active => false);
--   select cron.alter_job((select jobid from cron.job where jobname = 'signal-scan-5min'), active => true);
-- Remove entirely:
--   select cron.unschedule('signal-scan-5min');
--
-- NOTE: the function URL below is this repo's linked project
-- (dzcwpaegqvhigceuxiop). Forks must replace the hostname with their own
-- project ref and keep everything else identical.

create extension if not exists "pg_cron" with schema "extensions";
create extension if not exists "pg_net" with schema "extensions";

do $$
declare
  v_secret_count integer;
  v_function_url text := 'https://dzcwpaegqvhigceuxiop.supabase.co/functions/v1/signal-scan';
  v_job_sql text;
begin
  -- Vault itself ships with Supabase; guard anyway for local/postgres parity.
  if to_regclass('vault.decrypted_secrets') is null then
    raise notice 'signal-scan cron: vault unavailable — extensions enabled, job NOT scheduled (store the secret, then re-apply).';
    return;
  end if;

  select count(*) into v_secret_count
  from vault.decrypted_secrets
  where name = 'signal_scan_service_key';

  if v_secret_count = 0 then
    raise notice 'signal-scan cron: vault secret signal_scan_service_key missing — extensions enabled, job NOT scheduled. See migration header for the one-time setup.';
    return;
  end if;

  -- Fire-and-collect POST: pg_net queues the request; the function runs the
  -- full scan synchronously and returns { ok, delivered, report }.
  -- 120s net timeout keeps the worker slot bounded; a timed-out tick is
  -- safe to retry next round (atomic claims suppress duplicate delivery).
  v_job_sql :=
    'select net.http_post(' ||
    'url := ''' || v_function_url || ''', ' ||
    'headers := jsonb_build_object(' ||
    '''Content-Type'', ''application/json'', ' ||
    '''Authorization'', ''Bearer '' || (select decrypted_secret from vault.decrypted_secrets where name = ''signal_scan_service_key''), ' ||
    '''apikey'', (select decrypted_secret from vault.decrypted_secrets where name = ''signal_scan_service_key'')' ||
    '), ' ||
    'body := ''{}''::jsonb, ' ||
    'timeout_milliseconds := 120000' ||
    ');';

  -- Re-runnable: drop any previous incarnation first (cron.schedule
  -- rejects duplicate job names). NOTE: never DELETE from cron.job
  -- directly — the SQL editor role has no write access to that table
  -- (42501). Use cron.unschedule(), which the role may call; the guard
  -- tolerates a missing job on first install.
  begin
    perform cron.unschedule('signal-scan-5min');
  exception
    when others then
      raise notice 'signal-scan cron: no previous job to remove (fresh schedule).';
  end;
  perform cron.schedule('signal-scan-5min', '*/5 * * * *', v_job_sql);
  raise notice 'signal-scan cron: job signal-scan-5min scheduled (*/5 * * * *).';
end;
$$;
