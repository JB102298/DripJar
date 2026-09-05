-- Migration 0025: Add an opt-in idempotency key to activity_events
--
-- WHY
--
-- `jar_commitment_phase` is a jar-lifecycle transition — a jar enters the
-- Commitment phase exactly once — but the reminder processor wrote one row per
-- invocation. Nothing recorded that the transition had already been logged, so
-- every run re-inserted it. In the development database that produced 57 641
-- rows across 283 jars: 57 358 surplus rows, 90 % of the entire activity table,
-- accumulated over eighteen days.
--
-- The processor cannot fix this on its own. `activity_events` had no unique
-- constraint other than its surrogate primary key, so a check-then-insert was
-- the only option available and two concurrent processors would both pass the
-- check. Uniqueness has to be enforced by the database, on the table whose
-- invariant it is.
--
-- WHY A NULLABLE, OPT-IN COLUMN
--
-- The obvious index — UNIQUE (jar_id) WHERE event_type = 'jar_commitment_phase'
-- — cannot be created: 283 jars already violate it, and historical activity is
-- not ours to delete or consolidate. It would also conscript every other
-- activity type into a uniqueness rule none of them wants; `contribution_added`
-- and `goal_updated` are genuinely repeatable.
--
-- A nullable key inverts that. NULL means "this row makes no uniqueness claim",
-- which is what all 64 004 existing rows mean and what every writer that still
-- uses the unconditional `logActivity` continues to mean. Only a writer that
-- can name a deterministic identity sets it.
--
-- WHY A PLAIN UNIQUE INDEX, NOT A PARTIAL ONE
--
-- PostgreSQL treats NULLs as distinct in a unique index, so a plain
-- UNIQUE (dedupe_key) already permits unlimited unclaimed rows — the partial
-- predicate would buy nothing. It costs something, though: `ON CONFLICT` can
-- only infer a partial index if the statement repeats the index predicate
-- verbatim, which would put a copy of this migration's WHERE clause into every
-- INSERT and keep it in sync forever. With a plain index the conflict target is
-- the column name and nothing else:
--
--     INSERT INTO activity_events (...) VALUES (...)
--       ON CONFLICT (dedupe_key) DO NOTHING RETURNING id
--
-- WHY THERE IS NO `IF NOT EXISTS` HERE
--
-- This is a versioned migration, not a reconciliation script. The journal is
-- the authority on whether it has run: `drizzle-kit migrate` applies it exactly
-- once and records it, and never offers it again.
--
-- So if `dedupe_key` or `activity_events_dedupe_key_idx` already exists at the
-- moment this runs, the journal and the database disagree — someone installed
-- part of this change by hand, a `drizzle-kit push` diffed it in, or a previous
-- run failed midway and left the schema half-built. `IF NOT EXISTS` would paper
-- over every one of those: the column would be accepted as-is without anyone
-- checking it is nullable TEXT, the index without anyone checking it is unique
-- and non-partial, and the backfill would then run against a table whose real
-- shape nobody verified. A migration that reports success on a database it did
-- not actually produce is worse than one that stops.
--
-- These statements therefore fail loudly on drift, which aborts the migration
-- and leaves the journal unmarked, so the discrepancy has to be looked at
-- rather than inherited. Re-runnability of this raw SQL is explicitly NOT a
-- goal; idempotency is the migration runner's job and it does it by recording
-- the entry, not by making every statement conditional.
--
-- WHAT THE BACKFILL DOES, AND WHAT IT REFUSES TO DO
--
-- Without a backfill the first processor run after this migration would find no
-- key for the 283 jars that already have the activity and would write a 284th
-- row for each. So exactly one already-existing row per affected jar is elected
-- as the canonical one and is given the key.
--
-- Election is deterministic: earliest `created_at`, with `id` breaking ties.
-- Two rows written in the same processor run share a timestamp to the
-- microsecond often enough that the tie-breaker is load-bearing, not
-- decorative.
--
-- The UPDATE writes the newly added column and nothing else. No activity row is
-- inserted or deleted, and no pre-existing user-visible field changes — id,
-- jar_id, user_id, event_type, description, amount_cents, metadata and
-- created_at are untouched on the elected row and on every duplicate. All
-- surplus historical duplicates remain present and visible, carrying
-- dedupe_key = NULL. This migration stops the bleeding; it does not rewrite
-- history.

ALTER TABLE activity_events
  ADD COLUMN dedupe_key TEXT;

-- Elect one canonical `jar_commitment_phase` row per jar and claim the key for
-- it. `DISTINCT ON (jar_id) ... ORDER BY jar_id, created_at, id` takes the
-- earliest row, resolving a timestamp tie by primary key so the same row is
-- elected on every database.
--
-- No guard against an already-set value is needed or wanted: the column was
-- created by the statement above, so every row holds NULL at this point. A
-- guard here would only imply a re-run this migration does not support.
UPDATE activity_events a
   SET dedupe_key = 'jar_commitment_phase:' || a.jar_id::text
  FROM (
    SELECT DISTINCT ON (jar_id) id
      FROM activity_events
     WHERE event_type = 'jar_commitment_phase'
     ORDER BY jar_id, created_at, id
  ) AS canonical
 WHERE a.id = canonical.id;

CREATE UNIQUE INDEX activity_events_dedupe_key_idx
  ON activity_events(dedupe_key);
