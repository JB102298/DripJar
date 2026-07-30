---
name: DB migration system
description: How TripJar manages database migrations with drizzle-kit — file locations, idempotency strategy, and reconciliation approach for already-applied schemas.
---

## Key facts

- Migration files live in `lib/db/drizzle/` (SQL) and `lib/db/drizzle/meta/` (snapshots + journal).
- drizzle-kit tracks applied migrations in the `drizzle.__drizzle_migrations` table (NOT public schema, NOT `__drizzle_migrations`).
- Run migrations: `pnpm --filter @workspace/db run migrate` (added in Sprint 1).
- Generate new migration: `pnpm --filter @workspace/db run generate` (requires TTY for rename prompts — see caveat below).

## drizzle-kit 0.31.x TTY caveat

`drizzle-kit generate` requires a TTY for any rename/column-conflict prompt. In non-TTY environments (CI, shell pipes), it throws an error. **Workaround**: hand-author the 0001 snapshot by modifying the previous snapshot JSON and write the SQL by hand, then update `_journal.json` manually.

**Why:** drizzle-kit 0.31.10 prompts interactively for renames; `echo "n" | drizzle-kit generate` throws because it checks `process.stdin.isTTY`.

## drizzle.config.ts path fix

`out` must be a **relative path** (`"./drizzle"`), NOT `path.join(__dirname, "./drizzle")`. An absolute path causes drizzle-kit to double-join with CWD, producing `.//absolute/path` which fails to open snapshots.

**Why:** drizzle-kit internally prepends `./` to the `out` value; an absolute path already starting with `/` breaks the join.

## Idempotency strategy (migrations 0000 + 0001)

All statements use narrow conditional guards so migrations are safe to re-run:
- `CREATE TABLE` → `CREATE TABLE IF NOT EXISTS`
- `CREATE [UNIQUE] INDEX` → `CREATE [UNIQUE] INDEX IF NOT EXISTS`
- `ALTER TABLE ADD CONSTRAINT` → `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '...') THEN ... END IF; END $$`
- Column rename → `DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE ...) THEN ... END IF; END $$`

**Why:** Dev DB was built via `drizzle-kit push` (no migration history). Plain SQL would fail with "relation already exists" / "constraint already exists". Narrow guards let migrations run as no-ops against an already-current schema without hiding unrelated errors.

## Current migration set (3 applied)

- 0000_initial_schema — 17 pre-Sprint-1 tables (reset_token, no refresh_sessions)
- 0001_sprint1_auth_hardening — renames reset_token → reset_token_hash, creates refresh_sessions with FK `refresh_sessions_user_id_fkey`
- 0002_align_refresh_session_fk_name — renames FK to `refresh_sessions_user_id_users_id_fk` (Drizzle convention); RENAME CONSTRAINT + state-handling DO block

Hashes (SHA-256 of SQL file content, recorded in drizzle.__drizzle_migrations):
- 0000: `5ebc22d9dad9cd21bd1dc29aa4e97ae66cda96a0c29bbb38f95ea79f68764e59`
- 0001: `bcbc0b21f034e9576776744dc20fc86d4aee8f7682a244088e5f95df44391bb6`
- 0002: `21f99d3b57b4ebf73260308cc6f7c48a42baf8d517c1ac454372a7e567dcfcef`

`drizzle-kit generate` produces "No schema changes, nothing to migrate" — schema.ts, snapshot, and DBs are fully aligned.

## Pre-seeding for databases built via push

For any DB built via `drizzle-kit push` (not migrate), seed the migration tracking table before running migrate:
```sql
CREATE SCHEMA IF NOT EXISTS drizzle;
CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint);
INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ('<sha256-of-sql-file>', <timestamp-ms>);
```
Hashes (SHA-256 of SQL file content):
- 0000_initial_schema: `5ebc22d9dad9cd21bd1dc29aa4e97ae66cda96a0c29bbb38f95ea79f68764e59`
- 0001_sprint1_auth_hardening: `bcbc0b21f034e9576776744dc20fc86d4aee8f7682a244088e5f95df44391bb6`
