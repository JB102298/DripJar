---
name: Drizzle journal registration for hand-written migrations
description: Manually written SQL migrations must be registered in meta/_journal.json or drizzle-kit silently skips them, and the tables are never created.
---

## Rule

When you manually create a `.sql` file in `lib/db/drizzle/` (instead of running `drizzle-kit generate`), you **must** also add the corresponding entry to `lib/db/drizzle/meta/_journal.json`.

**Why:** `drizzle-kit migrate` reads the journal to discover which migrations to apply. If an entry is missing, the command still exits 0 ("migrations applied successfully") but does nothing — the tables are never created in the database.

**How to apply:**
1. Add the entry to `_journal.json` with the next `idx` (integer), `version: "7"`, `when` (epoch ms), `tag` (filename without `.sql`), and `breakpoints: true`.
2. Then run `pnpm --filter @workspace/db run migrate` to let drizzle-kit register the hash in its `__drizzle_migrations` table.
3. If you already applied the SQL directly via `psql -f`, re-running migrate is still safe because the SQL uses `IF NOT EXISTS` / `ON CONFLICT DO NOTHING`.

**Pitfall discovered:** On Phase 4A, running `psql "$DATABASE_URL" -f 0008_phase4a_financial_ledger.sql` applied the tables but the missing journal entry meant `drizzle-kit migrate` reported success without recording the migration. Tests then failed with "relation does not exist" even though the SQL had run.
