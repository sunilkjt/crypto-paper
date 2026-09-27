-- CRYPTO-PAPER: Supabase cloud paper trading (PAPER ONLY, no real orders).
-- One paper account per user; positions/trades/snapshots are user-owned with RLS.
-- Extras beyond the required columns preserve the existing engine's full
-- PaperPosition fidelity (timeframe/setup/TP1-3/strength/thirds/realized/fees/...)
-- so NO calculation changes are needed client-side. Missing concepts in the
-- local engine default safely: leverage=1, funding=0.

-- Required for gen_random_uuid() on older projects; harmless if present.
create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- paper_accounts: one row per user (user_id UNIQUE prevents duplicates).
-- ---------------------------------------------------------------------------
create table if not exists public.paper_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  starting_balance double precision not null default 1000,
  current_balance double precision not null default 1000,
  -- Engine stats (preserved verbatim, never recomputed server-side):
  realized_pnl double precision not null default 0,
  fees_paid double precision not null default 0,
  closed_count integer not null default 0,
  wins integer not null default 0,
  peak_equity double precision not null default 1000,
  max_drawdown_pct double precision not null default 0,
  -- Engine config snapshot:
  risk_per_trade double precision not null default 0.01,
  fee_rate double precision not null default 0.0005,
  auto_paper_trading boolean not null default false,
  auto_min_strength integer not null default 75,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint paper_accounts_user_unique unique (user_id),
  constraint paper_accounts_balance_check check (starting_balance > 0 and current_balance >= 0)
);

-- ---------------------------------------------------------------------------
-- paper_positions: open + closed positions share one table keyed by the
-- engine's client-generated id (text PK => natural idempotency key: retries,
-- double-clicks, refreshes and realtime echoes upsert the same row).
-- Required columns: symbol/side/quantity/leverage/entry/current/SL/TP/unrealized.
-- ---------------------------------------------------------------------------
create table if not exists public.paper_positions (
  id text primary key,
  account_id uuid not null references public.paper_accounts (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  symbol text not null,
  side text not null check (side in ('LONG', 'SHORT')),
  quantity double precision not null check (quantity > 0),
  leverage double precision not null default 1,
  entry_price double precision not null check (entry_price > 0),
  current_price double precision,
  stop_loss double precision,
  take_profit double precision,
  unrealized_pnl double precision not null default 0,
  status text not null default 'OPEN',
  opened_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Engine-fidelity extras (nullable for forward-compat):
  timeframe text,
  setup_type text,
  tp1 double precision,
  tp2 double precision,
  tp3 double precision,
  invalidation double precision,
  strength double precision,
  thirds_remaining integer,
  realized double precision,
  fees double precision,
  notional double precision,
  margin double precision,
  risk double precision,
  close_reason text,
  closed_at timestamptz
);

-- ---------------------------------------------------------------------------
-- paper_trades: immutable history of closed positions. PK = position id, so a
-- close can only ever insert ONE history row (duplicate protection).
-- ---------------------------------------------------------------------------
create table if not exists public.paper_trades (
  id text primary key,
  account_id uuid not null references public.paper_accounts (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  symbol text not null,
  side text not null check (side in ('LONG', 'SHORT')),
  quantity double precision not null check (quantity > 0),
  leverage double precision not null default 1,
  entry_price double precision not null check (entry_price > 0),
  exit_price double precision,
  stop_loss double precision,
  take_profit double precision,
  fees double precision not null default 0,
  funding double precision not null default 0,
  realized_pnl double precision not null default 0,
  result text,
  signal_id text,
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  -- Engine-fidelity extras:
  timeframe text,
  setup_type text,
  tp1 double precision,
  tp2 double precision,
  tp3 double precision,
  strength double precision,
  close_reason text
);

-- ---------------------------------------------------------------------------
-- paper_equity_snapshots: throttled equity curve points (client writes at most
-- ~1/min while markets move; charting/debug only, never authoritative).
-- ---------------------------------------------------------------------------
create table if not exists public.paper_equity_snapshots (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.paper_accounts (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  equity double precision not null,
  balance double precision not null,
  unrealized_pnl double precision not null default 0,
  recorded_at timestamptz not null default now()
);

-- Indexes (hot paths: per-account sync + realtime filters).
create index if not exists paper_positions_account_idx on public.paper_positions (account_id);
create index if not exists paper_positions_user_idx on public.paper_positions (user_id);
create index if not exists paper_positions_status_idx on public.paper_positions (account_id, status);
create index if not exists paper_trades_account_idx on public.paper_trades (account_id);
create index if not exists paper_trades_user_idx on public.paper_trades (user_id);
create index if not exists paper_trades_closed_idx on public.paper_trades (account_id, closed_at desc);
create index if not exists paper_equity_account_time_idx on public.paper_equity_snapshots (account_id, recorded_at desc);

-- updated_at auto-touch.
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_paper_accounts_touch on public.paper_accounts;
create trigger trg_paper_accounts_touch
  before update on public.paper_accounts
  for each row execute function public.touch_updated_at();

drop trigger if exists trg_paper_positions_touch on public.paper_positions;
create trigger trg_paper_positions_touch
  before update on public.paper_positions
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- ROW LEVEL SECURITY: a user sees ONLY their own rows. Enforced in Postgres
-- via auth.uid() — frontend filtering is presentation only, never security.
-- user_id WITH CHECK stops forged inserts; account-ownership EXISTS stops
-- cross-account writes even within the same uid (defense in depth).
-- ---------------------------------------------------------------------------
alter table public.paper_accounts enable row level security;
alter table public.paper_positions enable row level security;
alter table public.paper_trades enable row level security;
alter table public.paper_equity_snapshots enable row level security;

-- paper_accounts: owner-only.
drop policy if exists paper_accounts_owner_select on public.paper_accounts;
create policy paper_accounts_owner_select on public.paper_accounts
  for select using (auth.uid() = user_id);
drop policy if exists paper_accounts_owner_insert on public.paper_accounts;
create policy paper_accounts_owner_insert on public.paper_accounts
  for insert with check (auth.uid() = user_id);
drop policy if exists paper_accounts_owner_update on public.paper_accounts;
create policy paper_accounts_owner_update on public.paper_accounts
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists paper_accounts_owner_delete on public.paper_accounts;
create policy paper_accounts_owner_delete on public.paper_accounts
  for delete using (auth.uid() = user_id);

-- paper_positions: owner-only + must belong to caller's account.
drop policy if exists paper_positions_owner_select on public.paper_positions;
create policy paper_positions_owner_select on public.paper_positions
  for select using (auth.uid() = user_id);
drop policy if exists paper_positions_owner_insert on public.paper_positions;
create policy paper_positions_owner_insert on public.paper_positions
  for insert with check (
    auth.uid() = user_id
    and exists (select 1 from public.paper_accounts a where a.id = account_id and a.user_id = auth.uid())
  );
drop policy if exists paper_positions_owner_update on public.paper_positions;
create policy paper_positions_owner_update on public.paper_positions
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists paper_positions_owner_delete on public.paper_positions;
create policy paper_positions_owner_delete on public.paper_positions
  for delete using (auth.uid() = user_id);

-- paper_trades: same pattern (immutable by convention; update allowed for
-- late exit-price corrections, still owner-only).
drop policy if exists paper_trades_owner_select on public.paper_trades;
create policy paper_trades_owner_select on public.paper_trades
  for select using (auth.uid() = user_id);
drop policy if exists paper_trades_owner_insert on public.paper_trades;
create policy paper_trades_owner_insert on public.paper_trades
  for insert with check (
    auth.uid() = user_id
    and exists (select 1 from public.paper_accounts a where a.id = account_id and a.user_id = auth.uid())
  );
drop policy if exists paper_trades_owner_update on public.paper_trades;
create policy paper_trades_owner_update on public.paper_trades
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists paper_trades_owner_delete on public.paper_trades;
create policy paper_trades_owner_delete on public.paper_trades
  for delete using (auth.uid() = user_id);

-- paper_equity_snapshots: owner-only.
drop policy if exists paper_equity_owner_select on public.paper_equity_snapshots;
create policy paper_equity_owner_select on public.paper_equity_snapshots
  for select using (auth.uid() = user_id);
drop policy if exists paper_equity_owner_insert on public.paper_equity_snapshots;
create policy paper_equity_owner_insert on public.paper_equity_snapshots
  for insert with check (
    auth.uid() = user_id
    and exists (select 1 from public.paper_accounts a where a.id = account_id and a.user_id = auth.uid())
  );
drop policy if exists paper_equity_owner_update on public.paper_equity_snapshots;
create policy paper_equity_owner_update on public.paper_equity_snapshots
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists paper_equity_owner_delete on public.paper_equity_snapshots;
create policy paper_equity_owner_delete on public.paper_equity_snapshots
  for delete using (auth.uid() = user_id);
