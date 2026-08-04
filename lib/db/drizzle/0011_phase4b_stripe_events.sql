-- Phase 4B: Stripe Webhook Event Store
--
-- Idempotency table for incoming Stripe webhook events.
-- The unique constraint on stripe_event_id prevents duplicate-delivery
-- double-posting. Exactly one row per Stripe event ID.
--
-- processing_status lifecycle:
--   'received'   → inserted by webhook endpoint before any handler runs
--   'processing' → claimed by handler (set inside the atomic DB transaction)
--   'processed'  → event fully handled; ledger posted (if applicable)
--   'failed'     → handler threw; Stripe will retry (event stays 'failed')
--   'ignored'    → unsupported/unknown event type; 200 returned to Stripe

CREATE TABLE IF NOT EXISTS stripe_webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stripe_event_id text NOT NULL,
  event_type text NOT NULL,
  stripe_created_at timestamp NOT NULL,
  received_at timestamp NOT NULL DEFAULT now(),
  processed_at timestamp,
  processing_status text NOT NULL DEFAULT 'received',
  financial_transaction_id uuid REFERENCES financial_transactions(id),
  error_message text,
  attempt_count integer NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS stripe_webhook_events_stripe_event_id_idx
  ON stripe_webhook_events(stripe_event_id);

CREATE INDEX IF NOT EXISTS stripe_webhook_events_ft_id_idx
  ON stripe_webhook_events(financial_transaction_id);

CREATE INDEX IF NOT EXISTS stripe_webhook_events_status_idx
  ON stripe_webhook_events(processing_status);
