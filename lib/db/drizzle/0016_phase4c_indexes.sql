-- Phase 4C: Additional Indexes
--
-- Supplemental indexes for Phase 4C access patterns not covered in earlier
-- migrations. All use IF NOT EXISTS so this migration is idempotent.

-- Dispatcher lookup: find allocations ready to dispatch (pending, no Stripe ID)
CREATE INDEX IF NOT EXISTS refund_allocations_dispatch_idx
  ON refund_allocations(provider_status, stripe_refund_id)
  WHERE provider_status = 'pending' AND stripe_refund_id IS NULL;

-- Webhook routing: look up allocation by stripe_refund_id (covered by unique idx,
-- but a separate non-partial index helps range scans)
CREATE INDEX IF NOT EXISTS refund_allocations_webhook_lookup_idx
  ON refund_allocations(stripe_refund_id);

-- Commitment snapshot expiry sweep
CREATE INDEX IF NOT EXISTS commitment_snapshots_status_expires_idx
  ON commitment_snapshots(status, expires_at)
  WHERE status = 'pending';

-- Fund commitment lookup by snapshot (idempotency check at confirm time)
CREATE INDEX IF NOT EXISTS fund_commitments_snapshot_idx
  ON fund_commitments(snapshot_id);
