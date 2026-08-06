-- Migration 0020: Saved payment methods
--
-- Each row represents a Stripe PaymentMethod that has been saved via a
-- SetupIntent with usage='off_session'. Used by AutoDrip to initiate
-- automatic off-session charges.
--
-- Status lifecycle:
--   active              → ready for use (card: immediately; ACH: after verification)
--   pending_verification → ACH SetupIntent confirmed but micro-deposit not yet verified
--   detached            → removed from DripJar (Stripe PM also detached)
--
-- Invariant: stripe_payment_method_id is globally unique (Stripe PM IDs are unique).

CREATE TABLE saved_payment_methods (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stripe_customer_id TEXT NOT NULL,
  stripe_payment_method_id TEXT NOT NULL,
  -- 'card' | 'us_bank_account'
  type TEXT NOT NULL,
  display_brand TEXT,
  last4 TEXT,
  bank_name TEXT,
  is_default BOOLEAN NOT NULL DEFAULT false,
  -- 'active' | 'pending_verification' | 'detached'
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX saved_payment_methods_stripe_pm_idx ON saved_payment_methods(stripe_payment_method_id);
CREATE INDEX saved_payment_methods_user_idx ON saved_payment_methods(user_id);
CREATE INDEX saved_payment_methods_customer_idx ON saved_payment_methods(stripe_customer_id);

ALTER TABLE saved_payment_methods
  ADD CONSTRAINT spm_status_check
    CHECK (status = ANY (ARRAY['active', 'pending_verification', 'detached']));

ALTER TABLE saved_payment_methods
  ADD CONSTRAINT spm_type_check
    CHECK (type = ANY (ARRAY['card', 'us_bank_account']));
