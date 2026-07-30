-- ─── Migration 0003: Refresh-token family tracking and revocation audit trail ──
--
-- Adds two columns to refresh_sessions:
--
--   revoke_reason  text, nullable
--     Controlled audit value set on every revocation.  Valid values:
--     'rotated', 'token_reuse_detected', 'logout', 'logout_all',
--     'password_reset', 'expired'
--
--   family_id  uuid, NOT NULL
--     Groups all tokens in one device-session rotation chain.  On login or
--     register a new UUID is minted (crypto.randomUUID() in application code).
--     On rotation the child session inherits the parent's family_id so the
--     entire chain stays linked.  Replay detection revokes all active sessions
--     sharing a family_id — not the entire user account.
--
--     Existing rows are each assigned their own row id as their family_id
--     (no extension required; id is already a uuid primary key).
--     New sessions created after this migration always have family_id set
--     explicitly by the application — the DEFAULT is only a safety net.
--
--     gen_random_uuid() is a pg_catalog built-in on PostgreSQL 13+
--     (confirmed pg_catalog on this cluster — no extension dependency).
--
-- This migration is idempotent: ADD COLUMN IF NOT EXISTS and
-- CREATE INDEX IF NOT EXISTS are safe to re-run.
-- ---------------------------------------------------------------------------

-- 1. Audit-trail column (nullable — older rows have no reason recorded)
ALTER TABLE "refresh_sessions" ADD COLUMN IF NOT EXISTS "revoke_reason" text;
--> statement-breakpoint

-- 2. Family-id column — add nullable first so the UPDATE backfill can run
--    before the NOT NULL constraint is enforced
ALTER TABLE "refresh_sessions" ADD COLUMN IF NOT EXISTS "family_id" uuid;
--> statement-breakpoint

-- 3. Backfill: assign each existing session its own row id as its family_id.
--    This requires no PostgreSQL extension and preserves the semantic that
--    each old session is its own single-session family.
UPDATE "refresh_sessions" SET "family_id" = "id" WHERE "family_id" IS NULL;
--> statement-breakpoint

-- 4. Enforce NOT NULL now that every row has a value
DO $$
BEGIN
  IF (
    SELECT is_nullable = 'YES'
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'refresh_sessions'
      AND column_name  = 'family_id'
  ) THEN
    ALTER TABLE "refresh_sessions" ALTER COLUMN "family_id" SET NOT NULL;
  END IF;
END $$;
--> statement-breakpoint

-- 5. Index to support efficient family-scoped revocation queries
CREATE INDEX IF NOT EXISTS "refresh_sessions_family_id_idx"
  ON "refresh_sessions" USING btree ("family_id");
