-- Phase 4C: Fund Commitments
--
-- A fund_commitment represents one contributor's explicit lock of their
-- refundable principal into the jar. One row per (member, jar) — a member
-- can only commit once per jar.
--
-- agreement_id / agreement_version are NOT NULL and preserved permanently;
-- later changes to the jar agreement do not mutate this record.
--
-- financial_transaction_id links to the commitment_transfer FT that posted
-- the CTRB_REFUNDABLE DR / CTRB_COMMITTED CR ledger entries.
--
-- commitment_allocations: one row per source Stripe PI, copied from the
-- validated snapshot. Used for FIFO lot audit trails.

CREATE TABLE IF NOT EXISTS fund_commitments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  jar_id uuid NOT NULL REFERENCES jars(id) ON DELETE RESTRICT,
  member_id uuid NOT NULL REFERENCES jar_members(id) ON DELETE RESTRICT,
  snapshot_id uuid NOT NULL REFERENCES commitment_snapshots(id) ON DELETE RESTRICT,
  agreement_id uuid NOT NULL REFERENCES agreements(id) ON DELETE RESTRICT,
  agreement_version text NOT NULL,
  total_committed_cents bigint NOT NULL,
  -- FK to the commitment_transfer financial_transaction that posted the ledger entries
  financial_transaction_id uuid REFERENCES financial_transactions(id) ON DELETE RESTRICT,
  created_at timestamp NOT NULL DEFAULT now()
);

-- Each member commits at most once per jar
CREATE UNIQUE INDEX IF NOT EXISTS fund_commitments_member_jar_idx
  ON fund_commitments(member_id, jar_id);

CREATE INDEX IF NOT EXISTS fund_commitments_jar_idx
  ON fund_commitments(jar_id);

CREATE TABLE IF NOT EXISTS commitment_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fund_commitment_id uuid NOT NULL REFERENCES fund_commitments(id) ON DELETE CASCADE,
  -- Source Stripe contribution financial_transaction (FIFO lot)
  source_ft_id uuid NOT NULL REFERENCES financial_transactions(id) ON DELETE RESTRICT,
  allocated_cents bigint NOT NULL,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS commitment_allocations_commitment_idx
  ON commitment_allocations(fund_commitment_id);

CREATE INDEX IF NOT EXISTS commitment_allocations_source_ft_idx
  ON commitment_allocations(source_ft_id);
