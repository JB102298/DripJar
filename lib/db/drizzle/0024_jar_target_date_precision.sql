-- Migration 0024: Add target_date_precision to jars
--
-- WHY
--
-- `target_date` is a `date`, so every jar has a stored day whether or not the
-- organizer knew one. "We want the house deposit ready sometime in 2031" and
-- "the cruise leaves on 14 March 2027" are indistinguishable in the column, and
-- rendering the first as "January 1, 2031" asserts a precision nobody supplied.
-- This is not hypothetical: an eighteen-year college fund has a known year and
-- no known month or day at all.
--
-- WHAT THIS COLUMN IS NOT
--
-- It does not change how dates are stored or compared. Coarser precisions are
-- normalised by the application to the start of their period (the 1st of the
-- month for 'monthYear', 1 January for 'year'), so `target_date` remains a real
-- calendar date and every existing comparison — `cutoff_date < target_date`,
-- schedule maths, reminder windows, days-remaining — keeps working with no
-- change. This column governs DISPLAY only.
--
-- BACKFILL
--
-- Existing rows take 'exact'. That is not merely a convenient default: every
-- jar created before this column was, in effect, already asserting a specific
-- day, and every surface rendered it as one. 'exact' preserves exactly the
-- behaviour those jars already have, so no existing jar's display changes.
--
-- The NOT NULL DEFAULT applies the backfill in the same statement; the explicit
-- UPDATE below is a belt-and-braces no-op that also repairs any row a partially
-- applied run could have left blank.
--
-- CONSTRAINT
--
-- A CHECK is safe here because the column is new: there is no pre-existing data
-- that could violate it. Note the deliberate contrast with `jars.category`,
-- which is NOT constrained at the database level — 82 rows in the development
-- database carry the legacy value 'travel', and a CHECK would either fail to
-- apply or force rewriting historical rows. Category is enforced on write at
-- the request-validation layer instead, and tolerated on read.

ALTER TABLE jars
  ADD COLUMN target_date_precision TEXT NOT NULL DEFAULT 'exact';

UPDATE jars
  SET target_date_precision = 'exact'
  WHERE target_date_precision IS NULL OR target_date_precision = '';

ALTER TABLE jars
  ADD CONSTRAINT jars_target_date_precision_check
    CHECK (target_date_precision = ANY (ARRAY['exact', 'monthYear', 'year']));
