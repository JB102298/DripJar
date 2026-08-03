-- Phase 3 conformance corrections
-- Add email delivery state tracking to reminder_sent_events.
-- All statements are idempotent (IF NOT EXISTS / exception-based constraint guard).

ALTER TABLE "reminder_sent_events" ADD COLUMN IF NOT EXISTS "email_status" text NOT NULL DEFAULT 'pending';
ALTER TABLE "reminder_sent_events" ADD COLUMN IF NOT EXISTS "email_sent_at" timestamp;
ALTER TABLE "reminder_sent_events" ADD COLUMN IF NOT EXISTS "email_attempt_count" integer NOT NULL DEFAULT 0;
ALTER TABLE "reminder_sent_events" ADD COLUMN IF NOT EXISTS "email_last_attempt_at" timestamp;

-- Add CHECK constraint for allowed delivery states.
-- 'sending' is the atomic in-flight state — a row in 'sending' for more than
-- 5 minutes is considered stale (process crash) and is re-claimable.
-- Idempotent: DO/EXCEPTION block silently ignores duplicate_object.
DO $$ BEGIN
  ALTER TABLE "reminder_sent_events"
    ADD CONSTRAINT "rse_email_status_check"
    CHECK ("email_status" IN ('pending', 'sending', 'sent', 'failed', 'skipped_preference'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
