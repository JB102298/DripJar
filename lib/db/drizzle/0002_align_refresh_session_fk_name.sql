-- Align the refresh_sessions FK constraint name with the Drizzle convention.
--
-- The hand-authored 0001 migration created the constraint as
-- "refresh_sessions_user_id_fkey" rather than the Drizzle-derived name
-- "refresh_sessions_user_id_users_id_fk".  This migration corrects the name
-- using RENAME CONSTRAINT — no data, no columns, and no referential-integrity
-- behaviour are changed.
--
-- State-handling rules (exactly-once migration model):
--
--   old exists, new does not  → rename  (normal forward path)
--   new exists, old does not  → schema already aligned; emit NOTICE, do nothing
--                               (reconciliation path for environments pre-corrected
--                                outside the migration system)
--   both exist                → RAISE EXCEPTION  (unexpected — fail loudly)
--   neither exists            → RAISE EXCEPTION  (unexpected — fail loudly)

DO $$
DECLARE
  v_has_old boolean;
  v_has_new boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname    = 'refresh_sessions_user_id_fkey'
       AND conrelid   = 'public.refresh_sessions'::regclass
  ) INTO v_has_old;

  SELECT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname    = 'refresh_sessions_user_id_users_id_fk'
       AND conrelid   = 'public.refresh_sessions'::regclass
  ) INTO v_has_new;

  IF v_has_old AND NOT v_has_new THEN
    -- Normal forward path.
    ALTER TABLE "refresh_sessions"
      RENAME CONSTRAINT "refresh_sessions_user_id_fkey"
                     TO "refresh_sessions_user_id_users_id_fk";

  ELSIF v_has_new AND NOT v_has_old THEN
    -- Constraint already carries the target name.
    -- Treat as aligned (reconciliation path only).
    RAISE NOTICE 'Constraint refresh_sessions_user_id_users_id_fk already exists; skipping rename.';

  ELSIF v_has_old AND v_has_new THEN
    RAISE EXCEPTION
      'Unexpected schema state: both refresh_sessions_user_id_fkey and '
      'refresh_sessions_user_id_users_id_fk exist on public.refresh_sessions.';

  ELSE
    RAISE EXCEPTION
      'Unexpected schema state: neither refresh_sessions_user_id_fkey nor '
      'refresh_sessions_user_id_users_id_fk exists on public.refresh_sessions.';
  END IF;
END $$;
