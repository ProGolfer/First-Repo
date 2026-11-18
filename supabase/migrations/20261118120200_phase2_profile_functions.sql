-- Phase 2 / M1b — the only way to create, claim, or administer golfer sign-in links.
-- All functions are SECURITY DEFINER and decide everything from auth.uid() (the signed-in user).
-- Callers can never pass in "who they are". Anonymous (not signed in) callers cannot run any of them.
-- Requires 20261118120000_phase2_golfer_accounts.sql.
--
-- Linking an EXISTING league profile to a new email requires admin approval. A golfer who types an
-- existing name creates a pending request (not a golfer_accounts row). Brand-new names still go
-- through create_my_profile with no approval. Golfer-facing responses never include league_player_id.

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

-- Golfer-facing profile payload: name and admin flag only. The permanent id stays internal.
create or replace function public._profile_json(p_league_player_id uuid)
returns jsonb language sql stable security definer set search_path = public, pg_temp
as $$
  select jsonb_build_object('linked', true, 'name', lp.name, 'is_admin', ga.is_admin)
  from public.golfer_accounts ga join public.league_players lp on lp.id = ga.league_player_id
  where lp.id = p_league_player_id
$$;

create or replace function public._pending_json(p_name text)
returns jsonb language sql immutable
as $$ select jsonb_build_object('linked', false, 'status', 'pending', 'name', p_name) $$;

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

-- Latest claim-request status for the signed-in user (no internal ids).
create or replace function public.my_claim_status()
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  uid uuid := public._require_signed_in();
  lp uuid;
  req record;
begin
  select league_player_id into lp from public.golfer_accounts where auth_user_id = uid;
  if lp is not null then
    return public._profile_json(lp) || jsonb_build_object('status', 'linked');
  end if;
  select r.status, lp2.name
    into req
    from public.profile_claim_requests r
    join public.league_players lp2 on lp2.id = r.league_player_id
   where r.auth_user_id = uid
   order by coalesce(r.resolved_at, r.created_at) desc, r.created_at desc
   limit 1;
  if not found then
    return jsonb_build_object('linked', false, 'status', 'none');
  end if;
  return jsonb_build_object('linked', false, 'status', req.status, 'name', req.name);
end;
$$;

-- Does this name already exist? (tells the app whether to offer "request this profile") -----------------------
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
  if exists (select 1 from public.profile_claim_requests
              where auth_user_id = uid and league_player_id = lp.id and status = 'pending') then
    return jsonb_build_object(
      'status', 'pending',
      'rounds', (select count(*) from public.game_history where league_player_id = lp.id));
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
    raise exception 'name_claimable';   -- a league profile with this name already exists: request it instead
  end if;

  begin
    insert into public.league_players (name, normalized_name) values (display, n) returning id into lp;
  exception when unique_violation then
    raise exception 'name_claimable';
  end;

  -- Choosing a brand-new name withdraws any pending request this sign-in still has.
  insert into public.profile_claim_log (league_player_id, auth_user_id, action, acted_by, detail)
  select league_player_id, uid, 'reject', uid, 'withdrawn: created a new profile'
    from public.profile_claim_requests
   where auth_user_id = uid and status = 'pending';
  update public.profile_claim_requests
     set status = 'rejected', resolved_at = now(), resolved_by = uid, detail = 'withdrawn: created a new profile'
   where auth_user_id = uid and status = 'pending';

  insert into public.golfer_accounts (league_player_id, auth_user_id, claim_method) values (lp, uid, 'created');
  insert into public.profile_claim_log (league_player_id, auth_user_id, action, acted_by) values (lp, uid, 'create', uid);
  return public._profile_json(lp);
end;
$$;

-- Request to link an existing league profile. Does NOT insert golfer_accounts; an admin must approve.
create or replace function public.claim_legacy_profile(p_name text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  uid uuid := public._require_signed_in();
  n text := public.norm_golfer_name(p_name);
  existing uuid; lp record; pending record;
begin
  select league_player_id into existing from public.golfer_accounts where auth_user_id = uid;
  if existing is not null then
    if (select normalized_name from public.league_players where id = existing) = n then
      return public._profile_json(existing);
    end if;
    raise exception 'already_linked';
  end if;

  perform pg_advisory_xact_lock(hashtext('golfer_name:' || n));

  select id, name, active into lp from public.league_players where normalized_name = n for update;
  if not found or not lp.active then raise exception 'not_found'; end if;
  if exists (select 1 from public.golfer_accounts where league_player_id = lp.id) then
    raise exception 'already_claimed';
  end if;

  select * into pending from public.profile_claim_requests where auth_user_id = uid and status = 'pending' for update;
  if found then
    if pending.league_player_id = lp.id then
      return public._pending_json(lp.name);
    end if;
    -- One pending request per user: move the existing request to the newly chosen name.
    update public.profile_claim_requests
       set league_player_id = lp.id, requested_name = lp.name, created_at = now(), detail = 'replaced previous pending request'
     where id = pending.id;
    insert into public.profile_claim_log (league_player_id, auth_user_id, action, acted_by, detail)
      values (lp.id, uid, 'request', uid, 'replaced previous pending request');
    return public._pending_json(lp.name);
  end if;

  insert into public.profile_claim_requests (league_player_id, auth_user_id, requested_name)
    values (lp.id, uid, lp.name);
  insert into public.profile_claim_log (league_player_id, auth_user_id, action, acted_by)
    values (lp.id, uid, 'request', uid);
  return public._pending_json(lp.name);
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

create or replace function public.admin_list_claim_requests()
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp
as $$
begin
  perform public._require_signed_in();
  if not public.is_golfer_admin() then raise exception 'not_admin' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'request_id', r.id,
      'league_player_id', r.league_player_id,
      'name', lp.name,
      'email', u.email,
      'requested_at', r.created_at,
      'rounds', (select count(*) from public.game_history h where h.league_player_id = lp.id))
      order by r.created_at)
    from public.profile_claim_requests r
    join public.league_players lp on lp.id = r.league_player_id
    left join auth.users u on u.id = r.auth_user_id
    where r.status = 'pending'), '[]'::jsonb);
end;
$$;

create or replace function public.admin_approve_claim(p_request_id uuid)
returns boolean language plpgsql security definer set search_path = public, pg_temp
as $$
declare uid uuid := public._require_signed_in(); req record; other record;
begin
  if not public.is_golfer_admin() then raise exception 'not_admin' using errcode = '42501'; end if;
  select * into req from public.profile_claim_requests where id = p_request_id for update;
  if not found then raise exception 'not_found'; end if;
  if req.status is distinct from 'pending' then raise exception 'not_pending'; end if;
  if exists (select 1 from public.golfer_accounts where league_player_id = req.league_player_id) then
    raise exception 'already_claimed';
  end if;
  if exists (select 1 from public.golfer_accounts where auth_user_id = req.auth_user_id) then
    raise exception 'user_already_linked';
  end if;

  insert into public.golfer_accounts (league_player_id, auth_user_id, claim_method)
    values (req.league_player_id, req.auth_user_id, 'claimed');
  update public.profile_claim_requests
     set status = 'approved', resolved_at = now(), resolved_by = uid
   where id = req.id;
  insert into public.profile_claim_log (league_player_id, auth_user_id, action, acted_by)
    values (req.league_player_id, req.auth_user_id, 'approve', uid);

  -- Anyone else still waiting for this same profile is automatically declined.
  for other in
    select * from public.profile_claim_requests
     where league_player_id = req.league_player_id and status = 'pending' and id <> req.id
    for update
  loop
    update public.profile_claim_requests
       set status = 'rejected', resolved_at = now(), resolved_by = uid,
           detail = 'auto-rejected: profile approved for another sign-in'
     where id = other.id;
    insert into public.profile_claim_log (league_player_id, auth_user_id, action, acted_by, detail)
      values (other.league_player_id, other.auth_user_id, 'reject', uid, 'auto-rejected: profile approved for another sign-in');
  end loop;
  return true;
end;
$$;

create or replace function public.admin_reject_claim(p_request_id uuid)
returns boolean language plpgsql security definer set search_path = public, pg_temp
as $$
declare uid uuid := public._require_signed_in(); req record;
begin
  if not public.is_golfer_admin() then raise exception 'not_admin' using errcode = '42501'; end if;
  select * into req from public.profile_claim_requests where id = p_request_id for update;
  if not found then raise exception 'not_found'; end if;
  if req.status is distinct from 'pending' then raise exception 'not_pending'; end if;
  update public.profile_claim_requests
     set status = 'rejected', resolved_at = now(), resolved_by = uid
   where id = req.id;
  insert into public.profile_claim_log (league_player_id, auth_user_id, action, acted_by)
    values (req.league_player_id, req.auth_user_id, 'reject', uid);
  return true;
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
declare uid uuid := public._require_signed_in(); target uuid; other record;
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

  -- Pending requests for this profile (including one from the newly linked user) are no longer needed.
  for other in
    select * from public.profile_claim_requests
     where league_player_id = p_league_player_id and status = 'pending'
    for update
  loop
    update public.profile_claim_requests
       set status = 'rejected', resolved_at = now(), resolved_by = uid,
           detail = 'auto-rejected: profile relinked by admin'
     where id = other.id;
    insert into public.profile_claim_log (league_player_id, auth_user_id, action, acted_by, detail)
      values (other.league_player_id, other.auth_user_id, 'reject', uid, 'auto-rejected: profile relinked by admin');
  end loop;
  return true;
end;
$$;

-- Lock the doors: signed-in users only; the internal helpers are not callable from the browser ------------------
revoke execute on function
  public.norm_golfer_name(text), public.current_golfer_id(), public.is_golfer_admin(), public._require_signed_in(),
  public._profile_json(uuid), public._pending_json(text), public.my_golfer_profile(), public.my_claim_status(),
  public.check_profile_name(text), public.create_my_profile(text),
  public.claim_legacy_profile(text), public.admin_list_profiles(), public.admin_list_claim_requests(),
  public.admin_approve_claim(uuid), public.admin_reject_claim(uuid),
  public.admin_unlink_profile(uuid), public.admin_relink_profile(uuid, text)
  from public, anon, authenticated;   -- authenticated is re-granted below only for the ones the app calls
grant execute on function
  public.my_golfer_profile(), public.my_claim_status(), public.check_profile_name(text), public.create_my_profile(text),
  public.claim_legacy_profile(text), public.admin_list_profiles(), public.admin_list_claim_requests(),
  public.admin_approve_claim(uuid), public.admin_reject_claim(uuid),
  public.admin_unlink_profile(uuid), public.admin_relink_profile(uuid, text),
  public.current_golfer_id(), public.is_golfer_admin()
  to authenticated;
