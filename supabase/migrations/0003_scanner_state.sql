-- Headless signal-cron state (GitHub Actions schedule, no browser).
-- Stores monitor snapshots (per-category signal lifecycle) and delivery
-- cooldown maps so scheduled runs notify exactly once per fact.
--
-- SECURITY: RLS enabled with NO policies — only the service role (used by
-- the CI cron job) can read/write. Authenticated/anon API callers are
-- denied. Never reference this key from frontend code.

create table if not exists public.scanner_state (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

drop trigger if exists trg_scanner_state_touch on public.scanner_state;
create trigger trg_scanner_state_touch
  before update on public.scanner_state
  for each row execute function public.touch_updated_at();

alter table public.scanner_state enable row level security;
-- Intentionally no policies: service_role bypasses RLS; everyone else denied.
