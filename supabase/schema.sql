-- Build Spotter: accounts + credits.
-- Run this once in Supabase → SQL Editor → New query → paste → Run. Safe to run again.
--
-- How credits work
--   * Every account gets FREE scans each calendar month (UTC). The number comes from the server (default 5).
--     Unused free scans don't roll over; on the 1st of the month they reset to the full amount.
--   * Paid credits come from Stripe purchases and never expire.
--   * A scan uses a free scan first, then a paid credit. If the AI call fails, the scan is refunded.
--   * Only the server (service role key) can change balances. Signed-in users can only read their own rows.

create table if not exists public.credits (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  free_left   integer not null default 0 check (free_left >= 0),
  free_month  text    not null default '',
  paid        integer not null default 0 check (paid >= 0),
  updated_at  timestamptz not null default now()
);

create table if not exists public.credit_events (
  id          bigserial primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  delta       integer not null,
  kind        text not null,            -- free_grant | search_free | search_paid | refund_free | refund_paid | purchase
  ref         text,                     -- Stripe Checkout session id for purchases
  created_at  timestamptz not null default now()
);
create unique index if not exists credit_events_purchase_ref on public.credit_events (ref) where kind = 'purchase';
create index if not exists credit_events_user on public.credit_events (user_id, created_at desc);

alter table public.credits enable row level security;
alter table public.credit_events enable row level security;
drop policy if exists "read own credits" on public.credits;
create policy "read own credits" on public.credits for select using (auth.uid() = user_id);
drop policy if exists "read own credit events" on public.credit_events;
create policy "read own credit events" on public.credit_events for select using (auth.uid() = user_id);

-- Locks the user's row (creating it if needed) and tops free scans back up when a new month starts.
create or replace function public.bs_lock(p_user uuid, p_free integer)
returns public.credits language plpgsql security definer set search_path = public as $$
declare r public.credits; m text := to_char(now() at time zone 'utc', 'YYYY-MM');
begin
  insert into credits (user_id) values (p_user) on conflict (user_id) do nothing;
  select * into r from credits where user_id = p_user for update;
  if r.free_month <> m then
    update credits set free_left = greatest(p_free, 0), free_month = m, updated_at = now()
      where user_id = p_user returning * into r;
    insert into credit_events (user_id, delta, kind) values (p_user, greatest(p_free, 0), 'free_grant');
  end if;
  return r;
end $$;

create or replace function public.bs_balance(p_user uuid, p_free integer default 5)
returns json language plpgsql security definer set search_path = public as $$
declare r public.credits;
begin
  r := bs_lock(p_user, p_free);
  return json_build_object('free', r.free_left, 'paid', r.paid, 'month', r.free_month);
end $$;

-- Takes one scan. Returns ok=false (and the balance) when the user has nothing left.
create or replace function public.bs_spend(p_user uuid, p_free integer default 5)
returns json language plpgsql security definer set search_path = public as $$
declare r public.credits; src text;
begin
  r := bs_lock(p_user, p_free);
  if r.free_left > 0 then
    update credits set free_left = free_left - 1, updated_at = now() where user_id = p_user returning * into r; src := 'free';
  elsif r.paid > 0 then
    update credits set paid = paid - 1, updated_at = now() where user_id = p_user returning * into r; src := 'paid';
  else
    return json_build_object('ok', false, 'free', r.free_left, 'paid', r.paid);
  end if;
  insert into credit_events (user_id, delta, kind) values (p_user, -1, 'search_' || src);
  return json_build_object('ok', true, 'source', src, 'free', r.free_left, 'paid', r.paid);
end $$;

-- Gives back a scan when the AI call failed.
create or replace function public.bs_refund(p_user uuid, p_source text)
returns json language plpgsql security definer set search_path = public as $$
declare r public.credits;
begin
  if p_source = 'free' then
    update credits set free_left = free_left + 1, updated_at = now() where user_id = p_user returning * into r;
  else
    update credits set paid = paid + 1, updated_at = now() where user_id = p_user returning * into r;
  end if;
  insert into credit_events (user_id, delta, kind) values (p_user, 1, 'refund_' || case when p_source = 'free' then 'free' else 'paid' end);
  return json_build_object('free', r.free_left, 'paid', r.paid);
end $$;

-- Adds purchased credits. Each Stripe session can only be credited once (unique ref).
create or replace function public.bs_add_paid(p_user uuid, p_credits integer, p_ref text)
returns json language plpgsql security definer set search_path = public as $$
declare r public.credits;
begin
  if p_credits is null or p_credits <= 0 then raise exception 'bad credit amount'; end if;
  begin
    insert into credit_events (user_id, delta, kind, ref) values (p_user, p_credits, 'purchase', p_ref);
  exception when unique_violation then
    select * into r from credits where user_id = p_user;
    return json_build_object('added', 0, 'already', true, 'free', coalesce(r.free_left, 0), 'paid', coalesce(r.paid, 0));
  end;
  insert into credits (user_id, paid) values (p_user, p_credits)
    on conflict (user_id) do update set paid = credits.paid + excluded.paid, updated_at = now()
    returning * into r;
  return json_build_object('added', p_credits, 'already', false, 'free', r.free_left, 'paid', r.paid);
end $$;

-- Only the server may call these.
revoke all on function public.bs_lock(uuid, integer) from public, anon, authenticated;
revoke all on function public.bs_balance(uuid, integer) from public, anon, authenticated;
revoke all on function public.bs_spend(uuid, integer) from public, anon, authenticated;
revoke all on function public.bs_refund(uuid, text) from public, anon, authenticated;
revoke all on function public.bs_add_paid(uuid, integer, text) from public, anon, authenticated;
grant execute on function public.bs_balance(uuid, integer) to service_role;
grant execute on function public.bs_spend(uuid, integer) to service_role;
grant execute on function public.bs_refund(uuid, text) to service_role;
grant execute on function public.bs_add_paid(uuid, integer, text) to service_role;
