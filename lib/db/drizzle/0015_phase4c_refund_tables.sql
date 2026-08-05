-- Phase 4C: Refund Tables
--
-- Replaces refund_request_placeholders with production-grade tables.
-- PL/pgSQL guard: aborts if any rows exist in the placeholder table,
-- preventing accidental data loss in a future environment that has real data.
--
-- refund_requests: one per contributor refund request. Tracks aggregate status.
-- refund_allocations: one per source Stripe PI (FIFO lot). Each allocation is
--   dispatched as a separate Stripe refund call. Tracks per-allocation status.
--
-- Aggregate status lifecycle:
--   pending_provider → processing → completed / partially_failed / failed / cancelled
--
-- Per-allocation provider_status lifecycle:
--   pending → requires_action | succeeded | failed | cancelled
--   Terminal states: succeeded, failed, cancelled (no regression allowed)

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM refund_request_placeholders LIMIT 1) THEN
    RAISE EXCEPTION
      'Migration aborted: refund_request_placeholders contains rows. '
      'Migrate or delete existing data before applying this migration.';
  END IF;
END;
$$;

DROP TABLE IF EXISTS refund_request_placeholders;

CREATE TABLE IF NOT EXISTS refund_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  jar_id uuid NOT NULL REFERENCES jars(id) ON DELETE RESTRICT,
  member_id uuid NOT NULL REFERENCES jar_members(id) ON DELETE RESTRICT,
  requested_cents bigint NOT NULL,
  -- Aggregate status
  -- 'pending_provider'|'processing'|'completed'|'partially_failed'|'failed'|'cancelled'
  status text NOT NULL DEFAULT 'pending_provider',
  -- FK to the refund_reservation financial_transaction (CTRB_REFUNDABLE DR / REFUND_PENDING CR)
  reservation_ft_id uuid REFERENCES financial_transactions(id) ON DELETE RESTRICT,
  reason text,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS refund_requests_member_jar_idx
  ON refund_requests(member_id, jar_id);

CREATE INDEX IF NOT EXISTS refund_requests_status_idx
  ON refund_requests(status);

CREATE TABLE IF NOT EXISTS refund_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  refund_request_id uuid NOT NULL REFERENCES refund_requests(id) ON DELETE CASCADE,
  -- Source Stripe contribution financial_transaction (FIFO lot)
  source_ft_id uuid NOT NULL REFERENCES financial_transactions(id) ON DELETE RESTRICT,
  allocated_cents bigint NOT NULL,
  -- Per-allocation provider status
  -- 'pending'|'requires_action'|'succeeded'|'failed'|'cancelled'
  provider_status text NOT NULL DEFAULT 'pending',
  -- Populated after dispatcher calls Stripe
  stripe_refund_id text,
  -- FK to the finalization or reversal financial_transaction
  -- (REFUND_PENDING DR / REFUND_CLR CR  or  REFUND_PENDING DR / CTRB_REFUNDABLE CR)
  finalization_ft_id uuid REFERENCES financial_transactions(id) ON DELETE RESTRICT,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS refund_allocations_request_idx
  ON refund_allocations(refund_request_id);

CREATE INDEX IF NOT EXISTS refund_allocations_source_ft_idx
  ON refund_allocations(source_ft_id);

CREATE INDEX IF NOT EXISTS refund_allocations_stripe_refund_id_idx
  ON refund_allocations(stripe_refund_id)
  WHERE stripe_refund_id IS NOT NULL;

-- Idempotency: unique per (allocation, terminal success)
CREATE UNIQUE INDEX IF NOT EXISTS refund_allocations_stripe_refund_unique_idx
  ON refund_allocations(stripe_refund_id)
  WHERE stripe_refund_id IS NOT NULL;
