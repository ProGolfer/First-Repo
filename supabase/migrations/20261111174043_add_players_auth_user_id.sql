-- ALREADY APPLIED to the live project on 2026-11-11 (recorded here only so the repo matches the database).
-- Idempotent: running it again changes nothing. Not used by the Phase 2 sign-in work.
alter table public.players add column if not exists auth_user_id uuid;
