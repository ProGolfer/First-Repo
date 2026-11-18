-- RUN BY HAND, ONCE, ONLY AFTER Gabe has signed in with his email and requested the profile named "Gabe".
-- This approves that pending request, links his email to the Gabe profile, and makes him admin.
-- It does nothing if there is no pending request for that profile.
-- Not a migration: it is never applied automatically.
--
-- 1. Gabe signs in on the app and requests the existing "Gabe" profile (do this before sharing the
--    new sign-in with anyone else).
-- 2. Check the email on that request is Gabe's:
--      select u.email from profile_claim_requests r
--        join league_players lp on lp.id = r.league_player_id
--        join auth.users u on u.id = r.auth_user_id
--       where lp.normalized_name = 'gabe' and r.status = 'pending';
-- 3. Run the statement below.

with pending as (
  select r.id as request_id, r.league_player_id, r.auth_user_id
    from public.profile_claim_requests r
    join public.league_players lp on lp.id = r.league_player_id
   where lp.normalized_name = 'gabe'
     and r.status = 'pending'
   order by r.created_at
   limit 1
),
linked as (
  insert into public.golfer_accounts (league_player_id, auth_user_id, claim_method, is_admin, admin_granted_at)
  select p.league_player_id, p.auth_user_id, 'claimed', true, now()
    from pending p
  returning league_player_id, auth_user_id, is_admin, admin_granted_at
),
logged as (
  insert into public.profile_claim_log (league_player_id, auth_user_id, action, acted_by, detail)
  select p.league_player_id, p.auth_user_id, 'approve', p.auth_user_id, 'bootstrap admin seed'
    from pending p
  returning 1
)
update public.profile_claim_requests r
   set status = 'approved', resolved_at = now(), resolved_by = p.auth_user_id
  from pending p
 where r.id = p.request_id
returning r.league_player_id, r.status;
