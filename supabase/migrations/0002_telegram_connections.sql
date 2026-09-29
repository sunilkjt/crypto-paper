-- Telegram connection storage (paper-signal notifications only).
-- The bot token NEVER lives here (server secret TELEGRAM_BOT_TOKEN only).
-- One connection row per user; one-time connect tokens expire in 15 min.

-- ---------------------------------------------------------------------------
-- telegram_connections: user_id PK => one connection max, no duplicates.
-- ---------------------------------------------------------------------------
create table if not exists public.telegram_connections (
  user_id uuid primary key references auth.users (id) on delete cascade,
  telegram_chat_id text not null,
  telegram_username text,
  enabled boolean not null default true,
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- telegram_connect_tokens: single-use, short-lived link tokens.
-- Only a random token string is stored (no credentials of any kind).
-- ---------------------------------------------------------------------------
create table if not exists public.telegram_connect_tokens (
  token text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  expires_at timestamptz not null default now() + interval '15 minutes',
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists telegram_connect_tokens_user_idx
  on public.telegram_connect_tokens (user_id);

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_telegram_connections_touch on public.telegram_connections;
create trigger trg_telegram_connections_touch
  before update on public.telegram_connections
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- ROW LEVEL SECURITY: owner-only via auth.uid(). Edge functions acting for a
-- signed-in user forward that user's JWT, so these policies confine every
-- read/write to the caller's own rows. The Telegram webhook path (no user
-- JWT) uses the service role server-side and validates one-time tokens.
-- ---------------------------------------------------------------------------
alter table public.telegram_connections enable row level security;
alter table public.telegram_connect_tokens enable row level security;

drop policy if exists telegram_connections_owner_select on public.telegram_connections;
create policy telegram_connections_owner_select on public.telegram_connections
  for select using (auth.uid() = user_id);
drop policy if exists telegram_connections_owner_insert on public.telegram_connections;
create policy telegram_connections_owner_insert on public.telegram_connections
  for insert with check (auth.uid() = user_id);
drop policy if exists telegram_connections_owner_update on public.telegram_connections;
create policy telegram_connections_owner_update on public.telegram_connections
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists telegram_connections_owner_delete on public.telegram_connections;
create policy telegram_connections_owner_delete on public.telegram_connections
  for delete using (auth.uid() = user_id);

drop policy if exists telegram_connect_tokens_owner_select on public.telegram_connect_tokens;
create policy telegram_connect_tokens_owner_select on public.telegram_connect_tokens
  for select using (auth.uid() = user_id);
drop policy if exists telegram_connect_tokens_owner_insert on public.telegram_connect_tokens;
create policy telegram_connect_tokens_owner_insert on public.telegram_connect_tokens
  for insert with check (auth.uid() = user_id);
drop policy if exists telegram_connect_tokens_owner_delete on public.telegram_connect_tokens;
create policy telegram_connect_tokens_owner_delete on public.telegram_connect_tokens
  for delete using (auth.uid() = user_id);
