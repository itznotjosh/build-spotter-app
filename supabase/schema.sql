-- Build Spotter: accounts + credits.
-- Run this once in Supabase → SQL Editor → New query → paste → Run. Safe to run again.
--
-- How credits work
--   * Every account gets FREE scans each calendar month (UTC). The number comes from the server (default 5).
--     Unused free scans don't roll over; on the 1st of the month they reset to the full amount.
--   * Paid credits come from Stripe purchases and never expire.
--   * Sign-up sale: accounts made during a sale get a one-time bonus added to the same never-expiring balance
--     (kind 'bonus', one per account). The sale's size and dates are set on the server (SIGNUP_BONUS*).
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
  kind        text not null,            -- free_grant | search_free | search_paid | refund_free | refund_paid | purchase | bonus
  ref         text,                     -- Stripe Checkout session id for purchases
  created_at  timestamptz not null default now()
);
create unique index if not exists credit_events_purchase_ref on public.credit_events (ref) where kind = 'purchase';
create unique index if not exists credit_events_bonus_ref on public.credit_events (ref) where kind = 'bonus';
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
  if exists (select 1 from credit_events where ref = p_ref) then      -- this ref was already paid (purchase or sign-up bonus)
    select * into r from credits where user_id = p_user;
    return json_build_object('added', 0, 'already', true, 'free', coalesce(r.free_left, 0), 'paid', coalesce(r.paid, 0));
  end if;
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

-- Adds a one-time bonus (the sign-up sale). Each ref can only be paid once, under any kind.
create or replace function public.bs_add_bonus(p_user uuid, p_credits integer, p_ref text)
returns json language plpgsql security definer set search_path = public as $$
declare r public.credits;
begin
  if p_credits is null or p_credits <= 0 then raise exception 'bad credit amount'; end if;
  if exists (select 1 from credit_events where ref = p_ref) then
    select * into r from credits where user_id = p_user;
    return json_build_object('added', 0, 'already', true, 'free', coalesce(r.free_left, 0), 'paid', coalesce(r.paid, 0));
  end if;
  begin
    insert into credit_events (user_id, delta, kind, ref) values (p_user, p_credits, 'bonus', p_ref);
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
revoke all on function public.bs_add_bonus(uuid, integer, text) from public, anon, authenticated;
grant execute on function public.bs_balance(uuid, integer) to service_role;
grant execute on function public.bs_spend(uuid, integer) to service_role;
grant execute on function public.bs_refund(uuid, text) to service_role;
grant execute on function public.bs_add_paid(uuid, integer, text) to service_role;
grant execute on function public.bs_add_bonus(uuid, integer, text) to service_role;

-- ---------- Creative mode (AI build guide) ----------
-- A build session costs 1 scan and includes a set number of guide replies (GUIDE_REPLIES_PER_SCAN on the server).
-- Only the server touches this table.
create table if not exists public.guide_chats (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  replies     integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists guide_chats_user on public.guide_chats (user_id, created_at desc);
alter table public.guide_chats enable row level security;

-- One guide reply: counts it against the session, or starts a new session (1 scan) when there isn't one with replies left.
create or replace function public.bs_guide_turn(p_user uuid, p_chat uuid, p_free integer, p_max integer)
returns json language plpgsql security definer set search_path = public as $$
declare c public.guide_chats; s json;
begin
  if p_chat is not null then
    select * into c from guide_chats where id = p_chat and user_id = p_user for update;
  end if;
  if c.id is not null and c.replies < p_max then
    update guide_chats set replies = replies + 1, updated_at = now() where id = c.id returning * into c;
    s := bs_balance(p_user, p_free);
    return json_build_object('ok', true, 'chat', c.id, 'charged', false, 'replies', c.replies, 'free', (s->>'free')::int, 'paid', (s->>'paid')::int);
  end if;
  s := bs_spend(p_user, p_free);
  if not (s->>'ok')::boolean then
    return json_build_object('ok', false, 'free', (s->>'free')::int, 'paid', (s->>'paid')::int);
  end if;
  insert into guide_chats (user_id, replies) values (p_user, 1) returning * into c;
  return json_build_object('ok', true, 'chat', c.id, 'charged', true, 'source', s->>'source', 'replies', 1, 'free', (s->>'free')::int, 'paid', (s->>'paid')::int);
end $$;

-- Takes back a guide reply that failed: gives the reply back, and the scan too if that reply started the session.
create or replace function public.bs_guide_undo(p_user uuid, p_chat uuid, p_charged boolean, p_source text)
returns json language plpgsql security definer set search_path = public as $$
begin
  if p_charged then
    delete from guide_chats where id = p_chat and user_id = p_user;
    return bs_refund(p_user, coalesce(p_source, 'paid'));
  end if;
  update guide_chats set replies = greatest(replies - 1, 0), updated_at = now() where id = p_chat and user_id = p_user;
  return bs_balance(p_user, 5);
end $$;

revoke all on function public.bs_guide_turn(uuid, uuid, integer, integer) from public, anon, authenticated;
revoke all on function public.bs_guide_undo(uuid, uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.bs_guide_turn(uuid, uuid, integer, integer) to service_role;
grant execute on function public.bs_guide_undo(uuid, uuid, boolean, text) to service_role;

-- ---------- 3D garage (Creative mode, made with Meshy) ----------
-- One row per version of a user's 3D car. Each version is drawn from the previous one (prev_id), back to the
-- first version of that car (root_id). Only the server touches this table.
create table if not exists public.garage_jobs (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  kind        text not null,                -- start | update
  stage       text not null,                -- design | design_saving | model | saving | done | failed
  input       jsonb not null default '{}'::jsonb,
  cost        integer not null default 0,
  sources     text[] not null default '{}',
  file_url    text,
  error       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
alter table public.garage_jobs add column if not exists design_path text;
alter table public.garage_jobs add column if not exists design_id text;
alter table public.garage_jobs add column if not exists model_id text;
alter table public.garage_jobs add column if not exists views text[] not null default '{}';
alter table public.garage_jobs add column if not exists prev_id uuid references public.garage_jobs(id) on delete set null;
alter table public.garage_jobs add column if not exists root_id uuid references public.garage_jobs(id) on delete set null;
create index if not exists garage_jobs_user on public.garage_jobs (user_id, created_at desc);
alter table public.garage_jobs enable row level security;
revoke all on public.garage_jobs from anon, authenticated;
grant all on public.garage_jobs to service_role;

-- Finished models and their reference views (public read, so the app can show them; only the server can write).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('garage', 'garage', true, 52428800, array['model/gltf-binary', 'application/octet-stream', 'image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do update set public = true, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
