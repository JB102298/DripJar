-- Migration 0021: AutoDrip authorizations
--
-- One row per (member, jar, active authorization). A contributor authorizes
-- DripJar to initiate off-session PaymentIntents on their behalf on a schedule.
--
-- Status lifecycle:
--   active          → processor may create runs
--   paused          → processor skips; contributor can resume
--   needs_attention → payment failed or requires_action; blocks all future runs;
--                     ONLY cleared via POST /jars/:jarId/autodrip/resume
--   cancelled       → terminal; no future runs; no refunds
--   completed       → terminal; remainingExpectedPrincipal reached 0
--
-- next_run_at is stored as UTC timestamp derived from 9:00 AM <jar_time_zone>
-- on the next scheduled calendar date.

CREATE TABLE autodrip_authorizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  jar_id UUID NOT NULL REFERENCES jars(id) ON DELETE RESTRICT,
  member_id UUID NOT NULL REFERENCES jar_members(id) ON DELETE RESTRICT,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  saved_payment_method_id UUID NOT NULL REFERENCES saved_payment_methods(id) ON DELETE RESTRICT,
  principal_cents INTEGER NOT NULL,
  -- 'weekly' | 'biweekly' | 'monthly' | 'twiceMonthly'
  frequency TEXT NOT NULL,
  -- 'active' | 'paused' | 'needs_attention' | 'cancelled' | 'completed'
  status TEXT NOT NULL DEFAULT 'active',
  authorized_at TIMESTAMP NOT NULL DEFAULT NOW(),
  -- Version string of the consent terms shown to contributor at authorization time
  authorization_terms_version TEXT NOT NULL DEFAULT '1',
  paused_at TIMESTAMP,
  needs_attention_at TIMESTAMP,
  needs_attention_reason TEXT,
  cancelled_at TIMESTAMP,
  completed_at TIMESTAMP,
  next_run_at TIMESTAMP NOT NULL,
  last_run_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX autodrip_authorizations_jar_member_idx ON autodrip_authorizations(jar_id, member_id);
CREATE INDEX autodrip_authorizations_status_next_run_idx ON autodrip_authorizations(status, next_run_at);
CREATE INDEX autodrip_authorizations_user_idx ON autodrip_authorizations(user_id);

ALTER TABLE autodrip_authorizations
  ADD CONSTRAINT autodrip_auth_status_check
    CHECK (status = ANY (ARRAY['active', 'paused', 'needs_attention', 'cancelled', 'completed']));

ALTER TABLE autodrip_authorizations
  ADD CONSTRAINT autodrip_auth_frequency_check
    CHECK (frequency = ANY (ARRAY['weekly', 'biweekly', 'monthly', 'twiceMonthly']));

ALTER TABLE autodrip_authorizations
  ADD CONSTRAINT autodrip_auth_principal_positive CHECK (principal_cents > 0);
