-- Phase 3: cutoff date model, email notification preferences, reminder deduplication
-- All statements are idempotent (IF NOT EXISTS / IF COLUMN NOT EXISTS).

-- 1. Add cutoff_date to jars
ALTER TABLE "jars" ADD COLUMN IF NOT EXISTS "cutoff_date" date;

-- 2. Add email notification preference columns to profiles
ALTER TABLE "profiles" ADD COLUMN IF NOT EXISTS "email_pref_contribution_reminders" boolean NOT NULL DEFAULT true;
ALTER TABLE "profiles" ADD COLUMN IF NOT EXISTS "email_pref_cutoff_reminders" boolean NOT NULL DEFAULT true;
ALTER TABLE "profiles" ADD COLUMN IF NOT EXISTS "email_pref_lifecycle" boolean NOT NULL DEFAULT true;

-- 3. Idempotent reminder deduplication table
CREATE TABLE IF NOT EXISTS "reminder_sent_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "event_key" text NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "jar_id" uuid REFERENCES "jars"("id") ON DELETE SET NULL,
  "event_type" text NOT NULL,
  "sent_at" timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "reminder_sent_events_key_idx"  ON "reminder_sent_events" ("event_key");
CREATE INDEX        IF NOT EXISTS "reminder_sent_events_user_idx" ON "reminder_sent_events" ("user_id");
