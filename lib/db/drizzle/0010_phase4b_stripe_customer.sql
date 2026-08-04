-- Phase 4B: Stripe Customer ID on profiles + Phase 4B columns on financial_transactions
--
-- profiles.stripe_customer_id
--   Nullable Stripe Customer ID. Set on first Stripe payment initiation via
--   getOrCreateStripeCustomer(). The unique index prevents two profiles from
--   linking to the same Stripe customer.
--
-- financial_transactions.quote_expires_at
--   30-minute TTL for persisted fee quotes (providerStatus = 'quoted').
--   NULL for non-quoted transactions (simulated contributions, refunds, etc.).
--
-- financial_transactions.payment_method_category
--   'us_bank_account' | 'card' | NULL
--   Set when a quote is persisted with a payment method type.

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS stripe_customer_id text;

CREATE UNIQUE INDEX IF NOT EXISTS profiles_stripe_customer_id_idx
  ON profiles(stripe_customer_id);

ALTER TABLE financial_transactions
  ADD COLUMN IF NOT EXISTS quote_expires_at timestamp;

ALTER TABLE financial_transactions
  ADD COLUMN IF NOT EXISTS payment_method_category text;

-- Expand provider_status allowed values to include Phase 4B Stripe statuses
-- ('quoted' | 'provider_created' | 'processing' extend the existing set)
ALTER TABLE financial_transactions
  DROP CONSTRAINT IF EXISTS ft_provider_status_check;

ALTER TABLE financial_transactions
  ADD CONSTRAINT ft_provider_status_check
    CHECK (provider_status = ANY (ARRAY[
      'not_applicable', 'pending', 'succeeded', 'failed',
      'quoted', 'provider_created', 'processing', 'cancelled'
    ]));
