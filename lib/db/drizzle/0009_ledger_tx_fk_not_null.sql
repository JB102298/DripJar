-- Phase 4A Hardening: Enforce ledger_transactions.financial_transaction_id NOT NULL
--
-- Every ledger_transaction must belong to a financial_transaction.
-- Orphaned ledger_transactions (NULL financial_transaction_id) violate the
-- immutable double-entry model and must not exist.
--
-- Safety gate: abort the migration if any orphan rows are detected.
-- In a correctly-operating system this count should always be zero.

DO $$
DECLARE
  orphan_count bigint;
BEGIN
  SELECT COUNT(*) INTO orphan_count
  FROM ledger_transactions
  WHERE financial_transaction_id IS NULL;

  IF orphan_count > 0 THEN
    RAISE EXCEPTION
      'Migration aborted: % ledger_transactions row(s) have NULL '
      'financial_transaction_id. Resolve orphans before running this migration.',
      orphan_count;
  END IF;
END $$;

-- No orphans confirmed — safe to enforce NOT NULL.
ALTER TABLE ledger_transactions
  ALTER COLUMN financial_transaction_id SET NOT NULL;
