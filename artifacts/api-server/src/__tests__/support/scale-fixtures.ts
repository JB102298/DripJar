/**
 * Bulk fixture creation for the reminder-processor scale proof.
 *
 * ─── WHY THESE ARE NOT BUILT THROUGH THE API ─────────────────────────────────
 *
 * The scale test needs roughly 1 600 Saving jars in the database at once. Built
 * through `POST /jars` that is 1 600 HTTP round trips plus a launch, an
 * agreement, and an acceptance each — minutes of setup to measure a sub-second
 * endpoint. These rows exist only to be *scanned*, never to be exercised, so
 * they are written set-based: a handful of statements regardless of volume.
 *
 * ─── WHAT "INERT" MEANS ──────────────────────────────────────────────────────
 *
 * An inert jar is a fully-formed Saving jar that is nonetheless eligible for no
 * reminder of any kind:
 *
 *   - `cutoff_date` is NULL          → no cutoff_upcoming, no cutoff_reached
 *   - its agreement is accepted      → no agreement_required
 *   - it carries no schedule         → no contribution_due, no contribution_missed
 *
 * That is the shape a long-lived database accumulates, and it is the exact
 * residue that made the pre-M3 processor slow: every one of them cost a
 * per-jar agreement lookup, a per-jar member lookup, and a per-member profile
 * lookup, none of which could ever produce an event.
 *
 * Inert jars still carry an agreement and an active member on purpose. A jar
 * stripped of both would be excluded by a join and would prove nothing; these
 * reach the enrichment stage and are discarded there, which is the harder case.
 *
 * ─── TEARDOWN ────────────────────────────────────────────────────────────────
 *
 * Every account is tagged, so `purgeTaggedFixtures` finds and removes all of
 * this by the same query-driven route as every other fixture. Jars are spread
 * across a small number of owners rather than one per jar: the purge is
 * set-based per account, so a few owners holding many jars is markedly cheaper
 * to remove than many owners holding one each, and nothing under test depends
 * on the ratio.
 */

import { pool } from "@workspace/db";
import type { FixtureTag } from "./fixtures.js";

export interface ScaleSeedSpec {
  /**
   * Distinguishes one seed batch from another within the same file, so a test
   * can add a second population without colliding on the unique user email or
   * jar slug. Lowercase alphanumerics only.
   */
  batch: string;
  /** Saving jars eligible for no reminder at all. */
  inertJars: number;
  /** Jars carrying one active, unpaused, due-today schedule. */
  scheduleJars: number;
  /** Distinct accounts the jars are spread across. */
  owners?: number;
}

export interface ScaleSeedResult {
  ownerIds: string[];
  inertJarIds: string[];
  scheduleJarIds: string[];
  scheduleIds: string[];
  /** Wall-clock milliseconds the seed itself took. Reported, never asserted. */
  seedMs: number;
}

const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

/**
 * Create `owners` accounts and hand them `inertJars + scheduleJars` Saving jars.
 *
 * Returns the ids so a caller can scope its assertions to exactly these rows.
 */
export async function seedScaleFixtures(
  fixtures: FixtureTag,
  spec: ScaleSeedSpec,
): Promise<ScaleSeedResult> {
  if (!/^[a-z0-9]{1,12}$/.test(spec.batch)) {
    throw new Error(`[SCALE-FIXTURES] batch "${spec.batch}" must be 1-12 lowercase alphanumerics.`);
  }
  const owners = spec.owners ?? 8;
  const total = spec.inertJars + spec.scheduleJars;
  const started = Date.now();

  const ownerRows = await pool.query<{ id: string }>(
    `insert into users (email, password_hash, email_verified)
     select 'bulk' || $4 || 'owner' || g || '-' || $1 || '@test.invalid', $2, true
       from generate_series(1, $3::int) g
     returning id`,
    [
      fixtures.tag,
      "$2b$10$scalefixturenotarealhashvaluexxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      owners,
      spec.batch,
    ],
  );
  const ownerIds = ids(ownerRows.rows);

  await pool.query(
    `insert into profiles (user_id, first_name, last_name, display_name)
     select id, 'Bulk', 'Owner', 'Bulk Owner'
       from users where id = any($1::uuid[])`,
    [ownerIds],
  );

  // `ordinality` gives each generated jar a stable index, which is what makes
  // the owner assignment round-robin and the slug unique.
  const jarRows = await pool.query<{ id: string; n: string }>(
    `insert into jars
       (organizer_id, name, slug, category, target_date, goal_amount_cents,
        status, currency, time_zone, launched_at)
     select ($2::uuid[])[1 + ((g - 1) % $3::int)],
            'Bulk Jar ' || g || ' ' || $1,
            'bulk-' || $1 || '-' || $5 || '-' || g,
            'Vacation',
            current_date + 400,
            100000,
            'Saving',
            'USD',
            'America/New_York',
            now()
       from generate_series(1, $4::int) g
     returning id, split_part(name, ' ', 3) as n`,
    [fixtures.tag, ownerIds, owners, total, spec.batch],
  );

  // Deterministic split: the first `inertJars` by generated index are inert.
  const byIndex = jarRows.rows
    .map((r) => ({ id: r.id, n: Number(r.n) }))
    .sort((a, b) => a.n - b.n);
  const inertJarIds = byIndex.slice(0, spec.inertJars).map((r) => r.id);
  const scheduleJarIds = byIndex.slice(spec.inertJars).map((r) => r.id);
  const allJarIds = byIndex.map((r) => r.id);

  const memberRows = await pool.query<{ id: string; jar_id: string }>(
    `insert into jar_members (jar_id, user_id, role, status, joined_at)
     select j.id, j.organizer_id, 'organizer', 'active', now()
       from jars j where j.id = any($1::uuid[])
     returning id, jar_id`,
    [allJarIds],
  );

  const agreementRows = await pool.query<{ id: string }>(
    `insert into agreements (jar_id, version, content, effective_date)
     select id, '1.0', 'Bulk scale fixture agreement', current_date
       from jars where id = any($1::uuid[])
     returning id`,
    [allJarIds],
  );

  // Accepted by the only active member, so agreement_required never fires.
  await pool.query(
    `insert into agreement_acceptances (agreement_id, user_id)
     select a.id, j.organizer_id
       from agreements a join jars j on j.id = a.jar_id
      where a.id = any($1::uuid[])`,
    [ids(agreementRows.rows)],
  );

  const scheduleMemberIds = memberRows.rows
    .filter((m) => scheduleJarIds.includes(m.jar_id))
    .map((m) => m.id);

  let scheduleIds: string[] = [];
  if (scheduleMemberIds.length > 0) {
    // start_date = today ⇒ zero elapsed periods, nothing outstanding, next due
    // date is today ⇒ `due_today`. Exactly one contribution_due each.
    const scheduleRows = await pool.query<{ id: string }>(
      `insert into contribution_schedules
         (jar_id, member_id, frequency, amount_cents, start_date, is_active, is_paused)
       select m.jar_id, m.id, 'monthly', 25000, current_date, true, false
         from jar_members m where m.id = any($1::uuid[])
       returning id`,
      [scheduleMemberIds],
    );
    scheduleIds = ids(scheduleRows.rows);
  }

  return {
    ownerIds,
    inertJarIds,
    scheduleJarIds,
    scheduleIds,
    seedMs: Date.now() - started,
  };
}
