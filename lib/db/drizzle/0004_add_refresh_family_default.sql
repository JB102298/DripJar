-- ─── Migration 0004: Add DEFAULT gen_random_uuid() to refresh_sessions.family_id ──
--
-- Migration 0003 added family_id uuid NOT NULL but did not establish the
-- column DEFAULT that schema.ts (.defaultRandom()) and the 0003 snapshot
-- declare.  This migration aligns the database with the schema definition.
--
-- The default is a safety net only: application code always sets family_id
-- explicitly (crypto.randomUUID() on login/register, inherited on rotation).
-- No existing rows or family IDs are modified by this migration.
--
-- gen_random_uuid() is a pg_catalog built-in on PostgreSQL 13+ — no
-- extension dependency.  Idempotent: SET DEFAULT is safe to re-run.
-- ---------------------------------------------------------------------------

ALTER TABLE "refresh_sessions" ALTER COLUMN "family_id" SET DEFAULT gen_random_uuid();
