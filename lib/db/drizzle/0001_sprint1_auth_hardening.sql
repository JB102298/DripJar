-- Sprint 1: Auth-hardening schema changes
--
-- Change 1: Rename users.reset_token -> users.reset_token_hash
--   The column is renamed, not dropped and recreated, so existing values are
--   preserved in place.  The DO block is narrowly state-aware: it only skips
--   the rename when reset_token no longer exists (i.e. when this migration has
--   already been applied or the DB was built from a later baseline).  Any other
--   SQL error propagates normally.
--
-- Change 2: Create the refresh_sessions table (Sprint 1 auth-hardening).
--   CREATE TABLE IF NOT EXISTS is used because drizzle-kit migrate may be run
--   against a database where the table was created manually during Sprint 1.
--   The FK constraint and indexes use the same narrow-conditional pattern.

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'users'
      AND column_name  = 'reset_token'
  ) THEN
    ALTER TABLE users RENAME COLUMN reset_token TO reset_token_hash;
  END IF;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "refresh_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"user_agent" text,
	"ip_address" text,
	"expires_at" timestamp NOT NULL,
	"revoked_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"last_used_at" timestamp
);
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'refresh_sessions_user_id_fkey') THEN
    ALTER TABLE "refresh_sessions" ADD CONSTRAINT "refresh_sessions_user_id_fkey"
      FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "refresh_sessions_token_hash_idx" ON "refresh_sessions" USING btree ("token_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "refresh_sessions_user_id_idx" ON "refresh_sessions" USING btree ("user_id");
