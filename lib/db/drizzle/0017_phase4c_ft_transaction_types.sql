-- Migration 0017: Extend ft_transaction_type_check constraint for Phase 4C
--
-- Adds refund_reservation, refund_finalization, and refund_reversal to the
-- allowed transaction_type values on financial_transactions.
-- These are new internal types for the refund ledger flow.

ALTER TABLE financial_transactions
  DROP CONSTRAINT ft_transaction_type_check;

ALTER TABLE financial_transactions
  ADD CONSTRAINT ft_transaction_type_check
    CHECK (transaction_type = ANY (ARRAY[
      'contribution',
      'refund',
      'refund_reservation',
      'refund_finalization',
      'refund_reversal',
      'commitment_transfer',
      'payout',
      'card_spend',
      'adjustment',
      'reversal'
    ]));
