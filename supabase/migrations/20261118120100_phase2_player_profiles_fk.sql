-- Phase 2 / M7 — player_profiles.player_id pointed at the DAILY players table (ON DELETE CASCADE), but the app
-- saves profiles under the permanent league_players id. Saves would fail, and the nightly roster wipe would
-- cascade-delete profiles. Point the key at the permanent table instead.
-- player_profiles has 0 rows today, so no data moves. The new key is added NOT VALID (it applies to new rows) and
-- validated only if every existing row already matches, so this can never fail on or alter existing data.

alter table public.player_profiles drop constraint if exists player_profiles_player_id_fkey;

alter table public.player_profiles
  add constraint player_profiles_player_id_fkey
  foreign key (player_id) references public.league_players(id) on delete cascade
  not valid;

do $$
begin
  if not exists (
    select 1 from public.player_profiles p
    where not exists (select 1 from public.league_players l where l.id = p.player_id)
  ) then
    alter table public.player_profiles validate constraint player_profiles_player_id_fkey;
  end if;
end $$;
