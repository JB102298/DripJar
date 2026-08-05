-- Phase 4C: Commitment Snapshots
--
-- A commitment_snapshot records the server's FIFO-lot computation at preview time.
-- The snapshotToken is a random hex string passed back to the client; the client
-- submits it at confirm time. The server re-validates all snapshotted lots are
-- still individually available before posting the commitment transfer.
--
-- agreement_id / agreement_version are NOT NULL: commitment is only possible
-- after the contributor has accepted the current jar agreement.
--
-- commitment_snapshot_allocations: one row per source Stripe PaymentIntent.
-- The amounts stored here are exact; the confirm step validates each row
-- individually (not just the total).

CREATE TABLE IF NOT EXISTS commitment_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  jar_id uuid NOT NULL REFERENCES jars(id) ON DELETE CASCADE,
  member_id uuid NOT NULL REFERENCES jar_members(id) ON DELETE CASCADE,
  agreement_id uuid NOT NULL REFERENCES agreements(id) ON DELETE RESTRICT,
  agreement_version text NOT NULL,
  snapshot_token text NOT NULL,
  total_principal_cents bigint NOT NULL,
  -- 'pending' | 'confirmed' | 'expired' | 'stale'
  status text NOT NULL DEFAULT 'pending',
  expires_at timestamp NOT NULL,
  confirmed_at timestamp,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS commitment_snapshots_token_idx
  ON commitment_snapshots(snapshot_token);

CREATE INDEX IF NOT EXISTS commitment_snapshots_member_jar_idx
  ON commitment_snapshots(member_id, jar_id);

CREATE TABLE IF NOT EXISTS commitment_snapshot_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_id uuid NOT NULL REFERENCES commitment_snapshots(id) ON DELETE CASCADE,
  -- Source Stripe contribution financial_transaction
  source_ft_id uuid NOT NULL REFERENCES financial_transactions(id) ON DELETE RESTRICT,
  allocated_cents bigint NOT NULL,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS commitment_snapshot_allocations_snapshot_idx
  ON commitment_snapshot_allocations(snapshot_id);
