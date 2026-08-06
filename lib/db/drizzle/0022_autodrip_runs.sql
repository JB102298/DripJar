-- Migration 0022: AutoDrip runs
--
-- One row per scheduled occurrence attempt. IDs are pre-generated (UUID v4)
-- inside the transaction before Stripe is called — used as idempotency key.
--
-- idempotency_key format: autodrip:<authorizationId>:<scheduledFor_iso>
--   e.g. autodrip:550e8400-...:2026-08-15
--   Ensures exactly one run row per (authorization, calendar date) pair.
--
-- Status lifecycle:
--   scheduled      → row inserted, not yet processed (rarely visible)
--   processing     → Stripe PI created; awaiting webhook confirmation
--   succeeded      → payment_intent.succeeded webhook received; accounting posted
--   failed         → payment_intent.payment_failed webhook received
--   action_required → payment_intent requires_action (3DS challenge); auth → needs_attention
--   skipped        → occurrence permanently skipped (old missed run in catch-up)
--   cancelled      → jar terminal; authorization cancelled before run completed
--
-- financial_transaction_id: populated by webhook handler after accounting posted.
-- stripe_payment_intent_id: populated after PI is created (before webhook).

CREATE TABLE autodrip_runs (
  id UUID PRIMARY KEY,
  autodrip_authorization_id UUID NOT NULL REFERENCES autodrip_authorizations(id) ON DELETE RESTRICT,
  -- Calendar date this run was scheduled for (ISO yyyy-MM-dd)
  scheduled_for DATE NOT NULL,
  principal_cents INTEGER NOT NULL,
  -- 'scheduled'|'processing'|'succeeded'|'failed'|'action_required'|'skipped'|'cancelled'
  status TEXT NOT NULL DEFAULT 'scheduled',
  financial_transaction_id UUID REFERENCES financial_transactions(id) ON DELETE RESTRICT,
  stripe_payment_intent_id TEXT,
  -- Unique per (authorization, scheduled_for) — also used as Stripe idempotency key
  idempotency_key TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  failure_code TEXT,
  failure_message TEXT,
  started_at TIMESTAMP NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX autodrip_runs_idempotency_key_idx ON autodrip_runs(idempotency_key);
CREATE INDEX autodrip_runs_authorization_idx ON autodrip_runs(autodrip_authorization_id);
CREATE INDEX autodrip_runs_stripe_pi_idx ON autodrip_runs(stripe_payment_intent_id) WHERE stripe_payment_intent_id IS NOT NULL;

ALTER TABLE autodrip_runs
  ADD CONSTRAINT autodrip_run_status_check
    CHECK (status = ANY (ARRAY['scheduled', 'processing', 'succeeded', 'failed', 'action_required', 'skipped', 'cancelled']));

ALTER TABLE autodrip_runs
  ADD CONSTRAINT autodrip_run_principal_positive CHECK (principal_cents > 0);
