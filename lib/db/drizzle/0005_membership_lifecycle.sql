-- ─── Migration 0005: Membership lifecycle + email verification columns ──────
--
-- Adds:
--   invitations.revoked_at            — timestamp when an organizer revoked a
--                                       pending invitation (status = 'revoked')
--   jar_members.left_at               — timestamp when a member left voluntarily
--                                       (status = 'left')
--   jar_members.removed_at            — timestamp when the organizer removed a
--                                       member (status = 'removed')
--   users.verification_token_hash     — SHA-256 hash of the email verification
--                                       token (raw token never stored)
--   users.verification_token_expires_at — verification token expiry
--
-- All columns are nullable; no data is modified or destroyed.
-- Idempotent: ADD COLUMN IF NOT EXISTS is safe to re-run.
-- ---------------------------------------------------------------------------

ALTER TABLE "invitations" ADD COLUMN IF NOT EXISTS "revoked_at" timestamp;--> statement-breakpoint
ALTER TABLE "jar_members" ADD COLUMN IF NOT EXISTS "left_at" timestamp;--> statement-breakpoint
ALTER TABLE "jar_members" ADD COLUMN IF NOT EXISTS "removed_at" timestamp;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "verification_token_hash" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "verification_token_expires_at" timestamp;
