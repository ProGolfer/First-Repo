-- RUN BY HAND, ONCE, ONLY AFTER Gabe has signed in with his email and linked the profile named "Gabe".
-- Not a migration: it is never applied automatically. Steps:
--   1. Gabe signs in on the app and links his profile (do this before sharing the new sign-in with anyone else,
--      because linking is by name).
--   2. Check the email on that link is Gabe's:  select u.email from golfer_accounts ga
--        join league_players lp on lp.id = ga.league_player_id join auth.users u on u.id = ga.auth_user_id
--        where lp.normalized_name = 'gabe';
--   3. Run the statement below. It does nothing if the link does not exist yet.
update public.golfer_accounts
   set is_admin = true, admin_granted_at = now()
 where league_player_id = (select id from public.league_players where normalized_name = 'gabe')
returning league_player_id, is_admin, admin_granted_at;
