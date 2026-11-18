-- Phase 2 — "Did you mean …?" for look-alike names.
-- When a signed-in golfer types a brand-new name that looks like an existing, unclaimed, active
-- league profile (for example "Gabe B" vs "Gabe"), check_profile_name returns status 'suggest'
-- with display names and round counts only — never internal ids. The app can then send them
-- into the existing claim-request flow, or let them choose "No, I'm new" and create the name.
--
-- Also hardens a few earlier functions: fixed search_path on norm_golfer_name and _pending_json,
-- and revoke public/anon execute on the history-protection trigger function.
-- This file does not change league_players, game_history, or scoring.

-- Internal typo distance (Levenshtein), capped at 3. No extension required.
create or replace function public._golfer_name_distance(p_a text, p_b text)
returns integer
language plpgsql
immutable
strict
set search_path = public, pg_temp
as $$
declare
  a text := p_a;
  b text := p_b;
  la int := char_length(a);
  lb int := char_length(b);
  prev int[];
  curr int[];
  i int;
  j int;
  cost int;
  cap int := 2;
begin
  if a = b then return 0; end if;
  if abs(la - lb) > cap then return cap + 1; end if;
  if la = 0 then return lb; end if;
  if lb = 0 then return la; end if;

  prev := array[0];
  for j in 1..lb loop
    prev := prev || j;
  end loop;

  for i in 1..la loop
    curr := array[i];
    for j in 1..lb loop
      cost := case when substr(a, i, 1) = substr(b, j, 1) then 0 else 1 end;
      curr := curr || least(curr[j] + 1, prev[j + 1] + 1, prev[j] + cost);
    end loop;
    prev := curr;
  end loop;
  return prev[lb + 1];
end;
$$;

-- Look-alike rules (names already normalized): typed starts with existing + a space
-- or initial ("gabe b" / "gabe"), existing starts with typed at a word boundary
-- ("gabe" / "gabe bevan"), or a small typo distance.
create or replace function public._golfer_name_lookalike(p_typed text, p_existing text)
returns boolean
language sql
immutable
strict
set search_path = public, pg_temp
as $$
  select
    p_typed is distinct from p_existing
    and (
      p_typed like p_existing || ' %'
      or p_existing like p_typed || ' %'
      or public._golfer_name_distance(p_typed, p_existing)
         <= case when greatest(char_length(p_typed), char_length(p_existing)) >= 8 then 2 else 1 end
    );
$$;

-- Tight search_path on earlier helpers (same body as before).
create or replace function public.norm_golfer_name(p_name text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$ select lower(btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g'))) $$;

create or replace function public._pending_json(p_name text)
returns jsonb
language sql
immutable
set search_path = public, pg_temp
as $$ select jsonb_build_object('linked', false, 'status', 'pending', 'name', p_name) $$;

-- Extend check_profile_name: same exact-match statuses as before; when the typed name
-- would have been 'available', also offer unclaimed, active look-alikes.
create or replace function public.check_profile_name(p_name text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  uid uuid := public._require_signed_in();
  n text := public.norm_golfer_name(p_name);
  lp record;
  mine uuid;
  suggestions jsonb;
begin
  if length(n) < 2 or length(n) > 40 or n !~ '^[[:alnum:]][[:alnum:] .''-]*$' then
    return jsonb_build_object('status', 'invalid');
  end if;
  select league_player_id into mine from public.golfer_accounts where auth_user_id = uid;
  select id, active into lp from public.league_players where normalized_name = n;
  if found then
    if mine is not null and mine = lp.id then return jsonb_build_object('status', 'yours'); end if;
    if exists (select 1 from public.golfer_accounts where league_player_id = lp.id) then
      return jsonb_build_object('status', 'taken');
    end if;
    if exists (select 1 from public.profile_claim_requests
                where auth_user_id = uid and league_player_id = lp.id and status = 'pending') then
      return jsonb_build_object(
        'status', 'pending',
        'rounds', (select count(*) from public.game_history where league_player_id = lp.id));
    end if;
    return jsonb_build_object(
      'status', case when lp.active then 'claimable' else 'taken' end,
      'rounds', (select count(*) from public.game_history where league_player_id = lp.id));
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('name', s.name, 'rounds', s.rounds) order by s.rank, s.sort_name), '[]'::jsonb)
    into suggestions
    from (
      select
        lp2.name,
        (select count(*)::int from public.game_history h where h.league_player_id = lp2.id) as rounds,
        public.norm_golfer_name(lp2.name) as sort_name,
        case
          when n like public.norm_golfer_name(lp2.name) || ' %' then 0
          when public.norm_golfer_name(lp2.name) like n || ' %' then 1
          else 2 + public._golfer_name_distance(n, public.norm_golfer_name(lp2.name))
        end as rank
        from public.league_players lp2
       where lp2.active
         and not exists (select 1 from public.golfer_accounts ga where ga.league_player_id = lp2.id)
         and public._golfer_name_lookalike(n, public.norm_golfer_name(lp2.name))
       order by 4, 3
       limit 5
    ) s;

  if jsonb_array_length(suggestions) > 0 then
    return jsonb_build_object('status', 'suggest', 'suggestions', suggestions);
  end if;
  return jsonb_build_object('status', 'available');
end;
$$;

revoke execute on function
  public._golfer_name_distance(text, text),
  public._golfer_name_lookalike(text, text),
  public.norm_golfer_name(text),
  public._pending_json(text),
  public.check_profile_name(text),
  public.league_players_protect_history()
  from public, anon, authenticated;

grant execute on function public.check_profile_name(text) to authenticated;
