-- Migration 0019: Add time_zone column to jars
--
-- Captures the IANA timezone of the Jar at creation time (e.g. 'America/New_York').
-- Used exclusively for AutoDrip scheduling (9:00 AM Jar Time = UTC equivalent).
-- Immutable after creation — never updated by any application code.
-- Existing jars are backfilled with 'America/New_York' as a safe default.

ALTER TABLE jars
  ADD COLUMN time_zone TEXT NOT NULL DEFAULT 'America/New_York';

-- Backfill existing rows (all get the default; constraint already applied via DEFAULT)
UPDATE jars SET time_zone = 'America/New_York' WHERE time_zone IS NULL OR time_zone = '';
