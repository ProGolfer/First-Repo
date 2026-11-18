-- Phase 2 / M1 — permanent golfer profiles: link a signed-in person to their league_players row.
--
-- ADDITIVE ONLY. Nothing here edits, moves or deletes an existing row. league_players and
-- game_history keep every id and value they have today.
--
-- Design note: the link (and the admin flag) live in a NEW table instead of new columns on
-- league_players, because league_players currently has open "anyone can insert/update" policies.
-- Columns on that table could be forged by anyone holding the public key. A new table with RLS on
-- and no write access for anon/authenticated cannot.

-- 1) Who is signed in as which golfer ---------------------------------------------------------------
create table if not exists public.golfer_accounts (
  league_player_id uuid primary key references public.league_players(id) on delete restrict,
  auth_user_id     uuid not null unique references auth.users(id) on delete cascade,
  is_admin         boolean not null default false,
  admin_granted_by uuid references public.league_players(id) on delete set null,
  admin_granted_at timestamptz,
  claim_method     text not null check (claim_method in ('created', 'claimed', 'relinked')),
  claimed_at       timestamptz not null default now()
);

alter table public.golfer_accounts enable row level security;

drop policy if exists "golfers read own account" on public.golfer_accounts;
create policy "golfers read own account" on public.golfer_accounts
  for select to authenticated using (auth_user_id = auth.uid());

revoke all on public.golfer_accounts from public, anon, authenticated;
grant select on public.golfer_accounts to authenticated;   -- own row only (policy above); writes go through functions

-- 2) Audit trail of creates / claims / admin unlink+relink -------------------------------------------
create table if not exists public.profile_claim_log (
  id               bigint generated always as identity primary key,
  league_player_id uuid references public.league_players(id) on delete set null,
  auth_user_id     uuid,
  action           text not null check (action in ('create', 'claim', 'unlink', 'relink')),
  acted_by         uuid,
  detail           text,
  created_at       timestamptz not null default now()
);

alter table public.profile_claim_log enable row level security;   -- no policies: only the functions below touch it
revoke all on public.profile_claim_log from public, anon, authenticated;

-- 3) Protect history: a league player that has rounds or a linked account cannot be deleted --------------
create or replace function public.league_players_protect_history()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'league_players cannot be truncated';
  end if;
  if exists (select 1 from public.golfer_accounts where league_player_id = old.id)
     or exists (select 1 from public.game_history where league_player_id = old.id) then
    raise exception 'this golfer has league history or a sign-in link and cannot be deleted';
  end if;
  return old;
end;
$$;

drop trigger if exists league_players_protect_history_row on public.league_players;
create trigger league_players_protect_history_row
  before delete on public.league_players
  for each row execute function public.league_players_protect_history();

drop trigger if exists league_players_protect_history_truncate on public.league_players;
create trigger league_players_protect_history_truncate
  before truncate on public.league_players
  for each statement execute function public.league_players_protect_history();
