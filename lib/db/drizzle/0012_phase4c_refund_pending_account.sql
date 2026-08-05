-- Phase 4C: REFUND_PENDING Ledger Account
--
-- Liability/credit-normal account used as a reservation during the refund
-- pipeline. When a refund is requested, principal moves from CTRB_REFUNDABLE
-- into REFUND_PENDING (reservation). On Stripe confirmation it moves out to
-- REFUND_CLR (finalization); on failure it returns to CTRB_REFUNDABLE (reversal).
--
-- Account semantics:
--   DR CTRB_REFUNDABLE / CR REFUND_PENDING  → reservation (at request time)
--   DR REFUND_PENDING  / CR REFUND_CLR       → finalization (Stripe succeeded)
--   DR REFUND_PENDING  / CR CTRB_REFUNDABLE  → reversal (Stripe failed/cancelled)

INSERT INTO ledger_accounts (code, name, account_type, normal_balance, description)
  VALUES (
    'REFUND_PENDING',
    'Refund In-Flight Reservation',
    'liability',
    'credit',
    'Reservation account for principal committed to in-progress Stripe refunds.'
  )
  ON CONFLICT (code) DO NOTHING;
