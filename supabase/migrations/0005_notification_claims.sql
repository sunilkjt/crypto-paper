-- Atomic notification-delivery gate shared by browser sessions and the
-- headless cron. Exactly one worker may claim a fingerprint per cooldown
-- window; the claim is a single atomic statement (no SELECT-then-INSERT
-- race). Delivery failures must RELEASE the claim so a later attempt can
-- proceed instead of being suppressed as "delivered".
--
-- SECURITY: RLS enabled with NO policies (anon/authenticated denied at the
-- table level). All access goes through the SECURITY DEFINER functions
-- below, which accept calls from authenticated users and the service role
-- only — never anonymous callers.

create table if not exists public.notification_claims (
  fingerprint text primary key,
  last_sent timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists trg_notification_claims_touch on public.notification_claims;
create trigger trg_notification_claims_touch
  before update on public.notification_claims
  for each row execute function public.touch_updated_at();

alter table public.notification_claims enable row level security;

-- Atomic claim: insert, or — only when the previous claim is outside the
-- cooldown window — refresh the timestamp. Returns true exactly when the
-- caller won the delivery right for this window.
create or replace function public.claim_notification(
  p_fingerprint text,
  p_cooldown_ms integer,
  p_now timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cooldown interval;
  v_claimed boolean;
begin
  if p_fingerprint is null or p_fingerprint = '' then
    return false;
  end if;
  if p_cooldown_ms is null or p_cooldown_ms <= 0 then
    v_cooldown := interval '0 seconds';
  else
    v_cooldown := make_interval(secs => (p_cooldown_ms::double precision / 1000.0));
  end if;
  -- Authenticated users and the service role only; anonymous callers denied.
  if auth.uid() is null and current_user <> 'service_role' then
    return false;
  end if;
  with upsert as (
    insert into public.notification_claims (fingerprint, last_sent)
    values (p_fingerprint, p_now)
    on conflict (fingerprint) do update
      set last_sent = excluded.last_sent,
          updated_at = now()
      where notification_claims.last_sent <= excluded.last_sent - v_cooldown
    returning 1
  )
  select count(*) > 0 into v_claimed from upsert;
  return v_claimed;
exception
  when others then
    -- Fail closed on DB errors; callers fall back to their local gates.
    return false;
end;
$$;

-- Release a claim (delivery failed: a later attempt may proceed instead of
-- being suppressed for the whole cooldown window).
create or replace function public.release_notification_claim(
  p_fingerprint text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_fingerprint is null or p_fingerprint = '' then
    return;
  end if;
  if auth.uid() is null and current_user <> 'service_role' then
    return;
  end if;
  delete from public.notification_claims where fingerprint = p_fingerprint;
exception
  when others then
    return;
end;
$$;
