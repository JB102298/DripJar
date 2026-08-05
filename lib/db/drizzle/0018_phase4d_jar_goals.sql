-- Phase 4D: Jar Goals
--
-- Goals are planning metadata ONLY.
-- Goal mutations NEVER create ledger_entries, ledger_transactions,
-- financial_transactions, or Stripe calls.
-- All funding allocation is computed server-side (pure waterfall function)
-- from the existing financial ledger at query time — nothing is persisted.

CREATE TABLE jar_goals (
  id                     uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  jar_id                 uuid          NOT NULL REFERENCES jars(id) ON DELETE CASCADE,
  name                   text          NOT NULL,
  description            text,
  target_principal_cents integer       NOT NULL,
  sort_order             integer       NOT NULL DEFAULT 0,
  status                 text          NOT NULL DEFAULT 'active',
  created_at             timestamp     NOT NULL DEFAULT now(),
  updated_at             timestamp     NOT NULL DEFAULT now(),
  archived_at            timestamp,

  CONSTRAINT jar_goals_name_length
    CHECK (char_length(name) BETWEEN 1 AND 100),
  CONSTRAINT jar_goals_desc_length
    CHECK (description IS NULL OR char_length(description) <= 500),
  CONSTRAINT jar_goals_target_positive
    CHECK (target_principal_cents > 0),
  CONSTRAINT jar_goals_status_check
    CHECK (status IN ('active', 'archived'))
);

CREATE INDEX jar_goals_jar_id_status_sort_idx
  ON jar_goals (jar_id, status, sort_order);
