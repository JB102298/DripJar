-- Phase 4A: Financial Ledger Foundation
-- Adds immutable double-entry ledger, financial transaction model, and seeds
-- the system chart of accounts. All statements are idempotent.
--
-- Tables added:
--   ledger_accounts       — system chart of accounts (seeded below)
--   financial_transactions — per-event financial record with fee breakdown
--   ledger_transactions   — immutable balanced-entry group header
--   ledger_entries        — individual debit/credit lines (immutable after insert)
--
-- Money columns in new financial tables use BIGINT to avoid INTEGER overflow
-- ($21M limit) when aggregating ledger entries across a large platform.
-- Existing tables (contributions, jars, etc.) keep their INTEGER columns.
--
-- Debit/credit convention:
--   ASSET / EXPENSE   accounts: debit increases, credit decreases
--   LIABILITY / EQUITY / REVENUE accounts: credit increases, debit decreases

-- ─── ledger_accounts ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "ledger_accounts" (
  "id"               uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "code"             text NOT NULL,
  "name"             text NOT NULL,
  "account_type"     text NOT NULL,     -- 'asset'|'liability'|'revenue'|'expense'|'equity'
  "normal_balance"   text NOT NULL,     -- 'debit'|'credit'
  "currency"         text NOT NULL DEFAULT 'USD',
  "description"      text,
  "is_system_account" boolean NOT NULL DEFAULT true,
  "created_at"       timestamp NOT NULL DEFAULT now()
);

DO $$ BEGIN
  CREATE UNIQUE INDEX "ledger_accounts_code_idx" ON "ledger_accounts"("code");
EXCEPTION WHEN duplicate_table THEN NULL;
END $$;

-- ─── financial_transactions ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "financial_transactions" (
  "id"                              uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "jar_id"                          uuid NOT NULL REFERENCES "jars"("id") ON DELETE RESTRICT,
  "member_id"                       uuid NOT NULL REFERENCES "jar_members"("id") ON DELETE RESTRICT,
  "transaction_type"                text NOT NULL,
  "currency"                        text NOT NULL DEFAULT 'USD',
  "requested_principal_cents"       bigint NOT NULL,
  "dripjar_fee_cents"               bigint NOT NULL,
  "dripjar_fee_rate_bps"            integer NOT NULL,
  "processing_fee_estimated_cents"  bigint NOT NULL DEFAULT 0,
  "processing_fee_actual_cents"     bigint,
  "total_quoted_cents"              bigint NOT NULL,
  "provider_type"                   text,
  "provider_transaction_id"         text,
  "provider_status"                 text NOT NULL DEFAULT 'not_applicable',
  "ledger_posting_status"           text NOT NULL DEFAULT 'pending',
  "ledger_id"                       uuid,           -- FK added below after ledger_transactions exists
  "fund_destination_type"           text,
  "idempotency_key"                 text NOT NULL,
  "metadata"                        jsonb,
  "created_at"                      timestamp NOT NULL DEFAULT now(),
  "updated_at"                      timestamp NOT NULL DEFAULT now()
);

DO $$ BEGIN
  CREATE UNIQUE INDEX "financial_transactions_idempotency_key_idx"
    ON "financial_transactions"("idempotency_key");
EXCEPTION WHEN duplicate_table THEN NULL;
END $$;

DO $$ BEGIN
  CREATE INDEX "financial_transactions_jar_idx" ON "financial_transactions"("jar_id");
EXCEPTION WHEN duplicate_table THEN NULL;
END $$;

DO $$ BEGIN
  CREATE INDEX "financial_transactions_member_idx" ON "financial_transactions"("member_id");
EXCEPTION WHEN duplicate_table THEN NULL;
END $$;

DO $$ BEGIN
  CREATE INDEX "financial_transactions_ledger_idx" ON "financial_transactions"("ledger_id");
EXCEPTION WHEN duplicate_table THEN NULL;
END $$;

-- CHECK constraints for enum-like text columns
DO $$ BEGIN
  ALTER TABLE "financial_transactions"
    ADD CONSTRAINT "ft_transaction_type_check"
    CHECK ("transaction_type" IN (
      'contribution', 'refund', 'commitment_transfer',
      'payout', 'card_spend', 'adjustment', 'reversal'
    ));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "financial_transactions"
    ADD CONSTRAINT "ft_provider_status_check"
    CHECK ("provider_status" IN ('not_applicable', 'pending', 'succeeded', 'failed'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "financial_transactions"
    ADD CONSTRAINT "ft_ledger_posting_status_check"
    CHECK ("ledger_posting_status" IN ('pending', 'posted', 'failed'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "financial_transactions"
    ADD CONSTRAINT "ft_fund_destination_type_check"
    CHECK ("fund_destination_type" IS NULL OR
           "fund_destination_type" IN ('organizer_bank_payout', 'dripjar_card'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "financial_transactions"
    ADD CONSTRAINT "ft_principal_positive"
    CHECK ("requested_principal_cents" > 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "financial_transactions"
    ADD CONSTRAINT "ft_dripjar_fee_non_negative"
    CHECK ("dripjar_fee_cents" >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "financial_transactions"
    ADD CONSTRAINT "ft_processing_fee_non_negative"
    CHECK ("processing_fee_estimated_cents" >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─── ledger_transactions ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "ledger_transactions" (
  "id"                        uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "financial_transaction_id"  uuid REFERENCES "financial_transactions"("id") ON DELETE RESTRICT,
  "description"               text NOT NULL,
  "currency"                  text NOT NULL DEFAULT 'USD',
  -- Immutable after insert. Corrections use compensating transactions.
  "posted_at"                 timestamp NOT NULL DEFAULT now(),
  "created_at"                timestamp NOT NULL DEFAULT now()
);

DO $$ BEGIN
  CREATE INDEX "ledger_transactions_financial_tx_idx"
    ON "ledger_transactions"("financial_transaction_id");
EXCEPTION WHEN duplicate_table THEN NULL;
END $$;

-- ─── Add ledger_id FK to financial_transactions (now that ledger_transactions exists) ──

DO $$ BEGIN
  ALTER TABLE "financial_transactions"
    ADD CONSTRAINT "fk_financial_transactions_ledger"
    FOREIGN KEY ("ledger_id") REFERENCES "ledger_transactions"("id");
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─── ledger_entries ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "ledger_entries" (
  "id"                    uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "ledger_transaction_id" uuid NOT NULL REFERENCES "ledger_transactions"("id") ON DELETE RESTRICT,
  "account_id"            uuid NOT NULL REFERENCES "ledger_accounts"("id") ON DELETE RESTRICT,
  "entry_type"            text NOT NULL,   -- 'debit' | 'credit'
  "amount_cents"          bigint NOT NULL,
  "currency"              text NOT NULL DEFAULT 'USD',
  "memo"                  text,
  "created_at"            timestamp NOT NULL DEFAULT now()
);

DO $$ BEGIN
  CREATE INDEX "ledger_entries_tx_idx" ON "ledger_entries"("ledger_transaction_id");
EXCEPTION WHEN duplicate_table THEN NULL;
END $$;

DO $$ BEGIN
  CREATE INDEX "ledger_entries_account_idx" ON "ledger_entries"("account_id");
EXCEPTION WHEN duplicate_table THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "ledger_entries"
    ADD CONSTRAINT "le_entry_type_check"
    CHECK ("entry_type" IN ('debit', 'credit'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "ledger_entries"
    ADD CONSTRAINT "le_amount_positive"
    CHECK ("amount_cents" > 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─── Seed system chart of accounts ───────────────────────────────────────────
-- ON CONFLICT DO NOTHING makes this idempotent.

INSERT INTO "ledger_accounts" ("code", "name", "account_type", "normal_balance", "description")
VALUES
  ('EXT_PAY_CLR',     'External Payment Clearing',          'asset',     'debit',
   'Total customer charge received from payment provider. Debited on contribution, credited on refund outflow.'),
  ('CTRB_REFUNDABLE', 'Contributor Refundable Principal',    'liability', 'credit',
   'Principal owed back to the contributor if they request a refund before committing. Credited on contribution, debited on refund or commitment.'),
  ('CTRB_COMMITTED',  'Committed Jar Principal',             'liability', 'credit',
   'Principal locked for Jar payout after contributor explicitly commits. Credited on commitment_transfer.'),
  ('DJ_FEE_REVENUE',  'DripJar Service Fee Revenue',         'revenue',   'credit',
   'DripJar 3% service fee earned at contribution time. Non-refundable.'),
  ('PROC_FEE_CLR',    'Processing Fee Clearing',             'liability', 'credit',
   'Provider processing-fee pass-through. Not DripJar revenue. Credited on contribution (estimated), adjusted on reconciliation.'),
  ('REFUND_CLR',      'Refund Outflow Clearing',             'asset',     'debit',
   'Funds flowing back to contributor on principal refund. Credited to reduce asset when refund is processed.'),
  ('PAYOUT_CLR',      'Payout Destination Clearing',         'asset',     'debit',
   'Future: committed funds en route to organizer bank payout or DripJar Card.')
ON CONFLICT ("code") DO NOTHING;
