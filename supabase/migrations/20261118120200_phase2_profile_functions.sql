-- Phase 2 / M1b — the only way to create, claim, or administer golfer sign-in links.
-- All functions are SECURITY DEFINER and decide everything from auth.uid() (the signed-in user).
-- Callers can never pass in "who they are". Anonymous (not signed in) callers cannot run any of them.
-- Requires 20261118120000_phase2_golfer_accounts.sql.

-- Same normalization the app already uses for league_players.normalized_name (lower + trim),
-- plus collapsing repeated spaces so "Mike  S" and "Mike S" are the same person.
create or replace function public.norm_golfer_name(p_name text)
returns text language sql immutable
as $$ select lower(btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g'))) $$;

create or replace function public.current_golfer_id()
returns uuid language sql stable security definer set search_path = public, pg_temp
as $$ select league_player_id from public.golfer_accounts where auth_user_id = auth.uid() $$;

create or replace function public.is_golfer_admin()
returns boolean language sql stable security definer set search_path = public, pg_temp
as $$ select coalesce((select is_admin from public.golfer_accounts where auth_user_id = auth.uid()), false) $$;

-- internal: caller must be a real signed-in user
create or replace function public._require_signed_in()
returns uuid language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare uid uuid := auth.uid();
begin
  if uid is null or coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) then
    raise exception 'not_signed_in' using errcode = '28000';
  end if;
  return uid;
end;
$$;

create or replace function public._profile_json(p_league_player_id uuid)
returns jsonb language sql stable security definer set search_path = public, pg_temp
as $$
  select jsonb_build_object('linked', true, 'league_player_id', lp.id, 'name', lp.name, 'is_admin', ga.is_admin)
  from public.golfer_accounts ga join public.league_players lp on lp.id = ga.league_player_id
  where lp.id = p_league_player_id
$$;

-- Who am I? ------------------------------------------------------------------------------------------------
create or replace function public.my_golfer_profile()
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare uid uuid := public._require_signed_in(); lp uuid;
begin
  select league_player_id into lp from public.golfer_accounts where auth_user_id = uid;
  if lp is null then return jsonb_build_object('linked', false); end if;
  return public._profile_json(lp);
end;
$$;

-- Does this name already exist? (tells the app whether to offer "link my profile") -----------------------------
create or replace function public.check_profile_name(p_name text)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  uid uuid := public._require_signed_in();
  n text := public.norm_golfer_name(p_name);
  lp record; mine uuid;
begin
  if length(n) < 2 or length(n) > 40 or n !~ '^[[:alnum:]][[:alnum:] .''-]*$' then
    return jsonb_build_object('status', 'invalid');
  end if;
  select league_player_id into mine from public.golfer_accounts where auth_user_id = uid;
  select id, active into lp from public.league_players where normalized_name = n;
  if not found then return jsonb_build_object('status', 'available'); end if;
  if mine is not null and mine = lp.id then return jsonb_build_object('status', 'yours'); end if;
  if exists (select 1 from public.golfer_accounts where league_player_id = lp.id) then
    return jsonb_build_object('status', 'taken');
  end if;
  return jsonb_build_object(
    'status', case when lp.active then 'claimable' else 'taken' end,
    'rounds', (select count(*) from public.game_history where league_player_id = lp.id));
end;
$$;

-- First-time profile: brand-new golfer, brand-new name ---------------------------------------------------------
create or replace function public.create_my_profile(p_name text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  uid uuid := public._require_signed_in();
  display text := btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g'));
  n text := public.norm_golfer_name(p_name);
  existing uuid; lp uuid; found_id uuid;
begin
  -- One sign-in = one profile. Asking again just returns the profile you already have.
  select league_player_id into existing from public.golfer_accounts where auth_user_id = uid;
  if existing is not null then return public._profile_json(existing); end if;

  if length(n) < 2 or length(n) > 40 or n !~ '^[[:alnum:]][[:alnum:] .''-]*$' then
    raise exception 'invalid_name';
  end if;

  perform pg_advisory_xact_lock(hashtext('golfer_name:' || n));

  select id into found_id from public.league_players where normalized_name = n;
  if found_id is not null then
    if exists (select 1 from public.golfer_accounts where league_player_id = found_id) then
      raise exception 'name_taken';
    end if;
    raise exception 'name_claimable';   -- a league profile with this name already exists: claim it instead
  end if;

  begin
    insert into public.league_players (name, normalized_name) values (display, n) returning id into lp;
  exception when unique_violation then
    raise exception 'name_claimable';
  end;

  insert into public.golfer_accounts (league_player_id, auth_user_id, claim_method) values (lp, uid, 'created');
  insert into public.profile_claim_log (league_player_id, auth_user_id, action, acted_by) values (lp, uid, 'create', uid);
  return public._profile_json(lp);
end;
$$;

-- Link an existing league profile (with its history) to the signed-in person ------------------------------------
create or replace function public.claim_legacy_profile(p_name text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  uid uuid := public._require_signed_in();
  n text := public.norm_golfer_name(p_name);
  existing uuid; lp record;
begin
  select league_player_id into existing from public.golfer_accounts where auth_user_id = uid;
  if existing is not null then
    if (select normalized_name from public.league_players where id = existing) = n then
      return public._profile_json(existing);
    end if;
    raise exception 'already_linked';
  end if;

  perform pg_advisory_xact_lock(hashtext('golfer_name:' || n));

  select id, active into lp from public.league_players where normalized_name = n for update;
  if not found or not lp.active then raise exception 'not_found'; end if;
  if exists (select 1 from public.golfer_accounts where league_player_id = lp.id) then
    raise exception 'already_claimed';
  end if;

  begin
    insert into public.golfer_accounts (league_player_id, auth_user_id, claim_method) values (lp.id, uid, 'claimed');
  exception when unique_violation then
    raise exception 'already_claimed';
  end;
  insert into public.profile_claim_log (league_player_id, auth_user_id, action, acted_by) values (lp.id, uid, 'claim', uid);
  return public._profile_json(lp.id);
end;
$$;

-- Admin tools: see who is linked, unlink a wrong claim, relink to the right person --------------------------------
create or replace function public.admin_list_profiles()
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp
as $$
begin
  perform public._require_signed_in();
  if not public.is_golfer_admin() then raise exception 'not_admin' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'league_player_id', lp.id, 'name', lp.name, 'active', lp.active,
      'linked', ga.league_player_id is not null, 'email', u.email, 'claimed_at', ga.claimed_at,
      'is_admin', coalesce(ga.is_admin, false),
      'rounds', (select count(*) from public.game_history h where h.league_player_id = lp.id))
      order by lp.normalized_name)
    from public.league_players lp
    left join public.golfer_accounts ga on ga.league_player_id = lp.id
    left join auth.users u on u.id = ga.auth_user_id), '[]'::jsonb);
end;
$$;

create or replace function public.admin_unlink_profile(p_league_player_id uuid)
returns boolean language plpgsql security definer set search_path = public, pg_temp
as $$
declare uid uuid := public._require_signed_in(); acct record;
begin
  if not public.is_golfer_admin() then raise exception 'not_admin' using errcode = '42501'; end if;
  select * into acct from public.golfer_accounts where league_player_id = p_league_player_id for update;
  if not found then raise exception 'not_linked'; end if;
  if acct.is_admin and (select count(*) from public.golfer_accounts where is_admin) <= 1 then
    raise exception 'last_admin';
  end if;
  delete from public.golfer_accounts where league_player_id = p_league_player_id;   -- the profile and its history stay
  insert into public.profile_claim_log (league_player_id, auth_user_id, action, acted_by)
    values (p_league_player_id, acct.auth_user_id, 'unlink', uid);
  return true;
end;
$$;

create or replace function public.admin_relink_profile(p_league_player_id uuid, p_email text)
returns boolean language plpgsql security definer set search_path = public, pg_temp
as $$
declare uid uuid := public._require_signed_in(); target uuid;
begin
  if not public.is_golfer_admin() then raise exception 'not_admin' using errcode = '42501'; end if;
  if not exists (select 1 from public.league_players where id = p_league_player_id) then raise exception 'not_found'; end if;
  if exists (select 1 from public.golfer_accounts where league_player_id = p_league_player_id) then raise exception 'already_linked'; end if;
  select id into target from auth.users where lower(email) = lower(btrim(p_email));
  if target is null then raise exception 'user_not_found'; end if;
  if exists (select 1 from public.golfer_accounts where auth_user_id = target) then raise exception 'user_already_linked'; end if;
  insert into public.golfer_accounts (league_player_id, auth_user_id, claim_method) values (p_league_player_id, target, 'relinked');
  insert into public.profile_claim_log (league_player_id, auth_user_id, action, acted_by)
    values (p_league_player_id, target, 'relink', uid);
  return true;
end;
$$;

-- Lock the doors: signed-in users only; the internal helpers are not callable from the browser ------------------
revoke execute on function
  public.norm_golfer_name(text), public.current_golfer_id(), public.is_golfer_admin(), public._require_signed_in(),
  public._profile_json(uuid), public.my_golfer_profile(), public.check_profile_name(text), public.create_my_profile(text),
  public.claim_legacy_profile(text), public.admin_list_profiles(), public.admin_unlink_profile(uuid),
  public.admin_relink_profile(uuid, text)
  from public, anon, authenticated;   -- authenticated is re-granted below only for the ones the app calls
grant execute on function
  public.my_golfer_profile(), public.check_profile_name(text), public.create_my_profile(text),
  public.claim_legacy_profile(text), public.admin_list_profiles(), public.admin_unlink_profile(uuid),
  public.admin_relink_profile(uuid, text), public.current_golfer_id(), public.is_golfer_admin()
  to authenticated;
