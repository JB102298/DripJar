-- Migration 0023: AutoDrip enum/type extensions
--
-- 1. Extends ft_transaction_type_check to include 'autodrip_contribution'
--    (the financial_transaction type posted when an AutoDrip run succeeds).
--
-- 2. No changes needed to contributions.source_type or activity_events.event_type —
--    those columns have no CHECK constraints and accept any TEXT value.
--    New values 'stripe_test_autodrip' (source_type) and the 7 autodrip_*
--    activity types are documented here for reference only.
--
-- New contribution source types (no constraint, TEXT column):
--   stripe_test_autodrip  — AutoDrip off-session payment succeeded (webhook)
--
-- New activity event types (no constraint, TEXT column):
--   autodrip_enabled, autodrip_paused, autodrip_resumed, autodrip_cancelled,
--   autodrip_succeeded, autodrip_failed, autodrip_payment_method_changed

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
      'autodrip_contribution',
      'payout',
      'card_spend',
      'adjustment',
      'reversal'
    ]));
