# Supabase — Money Game Central

**Nothing in `supabase/migrations/` has been applied to the live project except the one marked ALREADY APPLIED.**
Apply in filename order, one at a time, only with Gabe's OK.

| File | What it does | Touches existing data? |
|---|---|---|
| `20261111174043_add_players_auth_user_id.sql` | ALREADY APPLIED (2026-11-11). Kept so the repo matches the database. | no |
| `20261118120000_phase2_golfer_accounts.sql` | New tables `golfer_accounts` (sign-in ↔ golfer link, admin flag) and `profile_claim_log`; both RLS-locked. A guard that stops a golfer with rounds or a sign-in link from being deleted. | no |
| `20261118120100_phase2_player_profiles_fk.sql` | `player_profiles.player_id` now points at the permanent `league_players` instead of the nightly `players` table. Table has 0 rows. | no |
| `20261118120200_phase2_profile_functions.sql` | Sign-in-only functions: `my_golfer_profile`, `check_profile_name`, `create_my_profile`, `claim_legacy_profile`, `admin_list_profiles`, `admin_unlink_profile`, `admin_relink_profile` (+ helpers). | no |

`seed/admin-gabe-after-claim.sql` is NOT a migration. Run it by hand once, after Gabe has signed in and linked "Gabe".

`checks/legacy-mapping-check.sql` is read-only. Run it before and after applying; every number and hash must match.

## Undo (only if ever needed; removes new objects only, never league data)
```sql
drop function if exists public.admin_relink_profile(uuid, text), public.admin_unlink_profile(uuid), public.admin_list_profiles(),
  public.claim_legacy_profile(text), public.create_my_profile(text), public.check_profile_name(text), public.my_golfer_profile(),
  public._profile_json(uuid), public._require_signed_in(), public.is_golfer_admin(), public.current_golfer_id(), public.norm_golfer_name(text);
drop trigger if exists league_players_protect_history_row on public.league_players;
drop trigger if exists league_players_protect_history_truncate on public.league_players;
drop function if exists public.league_players_protect_history();
drop table if exists public.profile_claim_log, public.golfer_accounts;
-- (M7 can stay; it only fixes a wrong foreign key on an empty table.)
```

## Auth settings the magic link needs (Dashboard → Authentication) — not changed by any file here
See the Phase 2 report: Site URL, Redirect URLs, email provider/SMTP, email template.

## Tests
`cd tests && npm install && npm test` — PGlite (Postgres in Node) with fake golfers only.
