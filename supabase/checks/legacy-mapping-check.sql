-- READ-ONLY. Fingerprint of the legacy league data. Run before and after applying the Phase 2 migrations;
-- all numbers and both hashes must be identical.
select
  (select count(*) from public.league_players)                              as league_players,
  (select count(*) from public.game_history)                                as game_history_rows,
  (select count(*) from public.game_history where league_player_id is null) as history_rows_unlinked,
  (select md5(string_agg(to_jsonb(g)::text, '|' order by g.id)) from public.game_history g)               as game_history_md5,
  (select md5(string_agg(to_jsonb(l)::text, '|' order by l.normalized_name)) from public.league_players l) as league_players_md5,
  (select md5(string_agg(g.id || ':' || coalesce(g.league_player_id::text, 'null'), '|' order by g.id))
     from public.game_history g)                                                                           as history_to_golfer_map_md5;
