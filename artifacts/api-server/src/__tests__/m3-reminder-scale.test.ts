/**
 * M3 — query budget and scale.
 *
 * ─── WHAT THIS FILE ASSERTS ──────────────────────────────────────────────────
 *
 * The pre-M3 processor issued one statement per Saving jar it considered, so a
 * database that accumulated jars got slower whether or not any of them could
 * produce a reminder. On 1 765 Saving jars with 165 due-today schedules it
 * issued 6 782 statements on a first run and 6 452 on a steady-state re-run —
 * 6 122 of them selection work that produced nothing.
 *
 * The primary proof here is the statement count, not the clock. A wall-clock
 * assertion on a shared, concurrently-written test database is a measurement of
 * the machine and of whatever else is running; the statement count is a
 * property of the algorithm and holds on any machine. Timing appears once, as a
 * generous ceiling, purely so a future change cannot reintroduce a per-row
 * round trip that happens to be cheap on this hardware.
 *
 * ─── WHY THE "IRRELEVANT" JARS ARE FULLY FORMED ──────────────────────────────
 *
 * Each of the 1 600 jars added below is a Saving jar with an active member and
 * an agreement that member has accepted. It is inert only because none of the
 * three eligibility rules matches it — not because it is missing rows that a
 * join would exclude cheaply. That is the shape a long-lived database
 * accumulates, and it is precisely the shape that used to cost three statements
 * apiece.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { pool } from "@workspace/db";
import app from "../app.js";
import {
  captureOrphanBaseline,
  createFixtureTag,
  teardownFixtures,
  withGlobalSweepExclusion,
  type OrphanBaseline,
} from "./support/fixtures.js";
import { countQueries, describeTally, type QueryTally } from "./support/query-counter.js";
import { seedScaleFixtures } from "./support/scale-fixtures.js";
import { CANDIDATE_BATCH_SIZE } from "../routes/reminders.js";

const BASE = "/api";
const INTERNAL_TOKEN = "m3-scale-internal-token";
const FIXTURES = createFixtureTag("m3scale");

/** The population the M3 objective names: ~1 600 Saving jars, ~165 schedules. */
const INERT_JARS = 1_600;
const ACTIVE_SCHEDULES = 165;

/**
 * Generous ceiling. The pre-M3 processor needed 10.1 s for the steady-state run
 * at this size and the suite had been carrying repeated 90-second timeouts on
 * reminder tests because of it. This bound is far below that and still leaves
 * ample room for a loaded machine running the rest of the suite in parallel.
 */
const SCALE_DEADLINE_MS = 30_000;

let orphanBaseline: OrphanBaseline;
const originalToken = process.env["INTERNAL_REMINDER_TOKEN"];

interface Measurement {
  tally: QueryTally;
  ms: number;
  stats: Record<string, number | string>;
}

/**
 * Seed (optionally) and then measure one processor run, both under a single
 * hold of the sweep lock.
 *
 * The lock has to span the seeding as well as the run. Another file's global
 * sweep is free to emit a candidate the moment it exists, and a candidate that
 * has already been settled elsewhere costs a different number of statements
 * than a fresh one — which would make every count here depend on the scheduling
 * of unrelated files. Seeding inside the hold makes this run the first sweep to
 * see what it seeded.
 *
 * Only the request itself is counted; the seeding statements are outside the
 * counter.
 */
async function seedAndMeasure<T>(seed?: () => Promise<T>): Promise<Measurement & { seeded: T }> {
  return withGlobalSweepExclusion(async () => {
    const seeded = (seed ? await seed() : undefined) as T;
    const started = Date.now();
    const { result, tally } = await countQueries(() =>
      request(app)
        .post(`${BASE}/internal/process-reminders`)
        .set("X-Internal-Token", INTERNAL_TOKEN),
    );
    const ms = Date.now() - started;
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    return { tally, ms, stats: result.body, seeded };
  });
}

const measure = (): Promise<Measurement> => seedAndMeasure();

beforeAll(async () => {
  orphanBaseline = await captureOrphanBaseline();
  process.env["INTERNAL_REMINDER_TOKEN"] = INTERNAL_TOKEN;
});

afterAll(async () => {
  await teardownFixtures(FIXTURES, {
    baseline: orphanBaseline,
    restore: () => {
      if (originalToken !== undefined) process.env["INTERNAL_REMINDER_TOKEN"] = originalToken;
      else delete process.env["INTERNAL_REMINDER_TOKEN"];
    },
  });
});

describe("M3 — selection cost does not scale with database residue", () => {
  let before: Measurement;
  let afterInert: Measurement;
  let firstRun: Measurement;
  let steadyState: Measurement;
  let scheduleIds: string[] = [];
  /** The accounts this file seeded. Used to assert on its own rows exactly. */
  const seededOwnerIds: string[] = [];

  it(
    "adding 1600 irrelevant Saving jars does not increase selection cost linearly",
    { timeout: 180_000 },
    async () => {
      before = await measure();

      const measured = await seedAndMeasure(() =>
        seedScaleFixtures(FIXTURES, {
          batch: "inert",
          inertJars: INERT_JARS,
          scheduleJars: 0,
        }),
      );
      expect(measured.seeded.inertJarIds).toHaveLength(INERT_JARS);
      seededOwnerIds.push(...measured.seeded.ownerIds);
      afterInert = measured;

      const added = afterInert.tally.selection - before.tally.selection;

      // Paging is allowed to cost more: the extra jars carry agreements, so
      // they extend the agreement candidate set by at most this many pages,
      // each of which costs a page query plus one enrichment query.
      // The slack absorbs pages other test files' candidates push us across
      // while this file is running; it is still two orders of magnitude below
      // the 4 800 statements the pre-M3 processor added for the same jars.
      const allowed = 2 * Math.ceil(INERT_JARS / CANDIDATE_BATCH_SIZE) + 10;
      expect(
        added,
        `selection grew by ${added} statements for ${INERT_JARS} extra jars ` +
          `(budget ${allowed}) — ${describeTally(afterInert.tally)}`,
      ).toBeLessThanOrEqual(allowed);

      // And, stated the other way round: sub-linear by more than two orders of
      // magnitude. The pre-M3 processor added exactly 3 × 1600 = 4800 here.
      expect(added).toBeLessThan(INERT_JARS / 50);
    },
  );

  it(
    `evaluates ${INERT_JARS} Saving jars and ${ACTIVE_SCHEDULES} schedules inside the deadline`,
    { timeout: 180_000 },
    async () => {
      const measured = await seedAndMeasure(() =>
        seedScaleFixtures(FIXTURES, {
          batch: "sched",
          inertJars: 0,
          scheduleJars: ACTIVE_SCHEDULES,
        }),
      );
      scheduleIds = measured.seeded.scheduleIds;
      expect(scheduleIds).toHaveLength(ACTIVE_SCHEDULES);
      seededOwnerIds.push(...measured.seeded.ownerIds);
      firstRun = measured;

      expect(
        firstRun.ms,
        `first run took ${firstRun.ms}ms — ${describeTally(firstRun.tally)}`,
      ).toBeLessThan(SCALE_DEADLINE_MS);

      // Every seeded schedule starts today, so each is due_today exactly once.
      const emitted = await pool.query(
        `select count(*)::int c from reminder_sent_events
          where event_key = any($1::text[])`,
        [scheduleIds.map((id) => `contribution_due:${id}:${new Date().toISOString().slice(0, 10)}`)],
      );
      expect(emitted.rows[0].c).toBe(ACTIVE_SCHEDULES);
    },
  );

  it("query counts scale only with pages and with events actually emitted", () => {
    // Selection is the number that must stay flat. It grew from an empty
    // database to 1 765 Saving jars by pages alone.
    const selectionGrowth = firstRun.tally.selection - before.tally.selection;
    const maxPages =
      Math.ceil((INERT_JARS + ACTIVE_SCHEDULES) / CANDIDATE_BATCH_SIZE) +
      Math.ceil(ACTIVE_SCHEDULES / CANDIDATE_BATCH_SIZE) +
      2;
    expect(selectionGrowth).toBeLessThanOrEqual(2 * maxPages + 4);

    // Per-event writes, on the other hand, are expected to scale — with events.
    // One notification and one terminal email write per newly emitted event.
    expect(firstRun.tally.notification).toBeGreaterThanOrEqual(ACTIVE_SCHEDULES);
    expect(firstRun.tally.emailState).toBeGreaterThanOrEqual(ACTIVE_SCHEDULES);
  });

  it(
    "a steady-state re-run costs a bounded number of statements, not one per settled event",
    { timeout: 180_000 },
    async () => {
      const notesFor = async () =>
        Number(
          (
            await pool.query(
              `select count(*)::int c from notifications where user_id = any($1::uuid[])`,
              [seededOwnerIds],
            )
          ).rows[0].c,
        );

      const notesBefore = await notesFor();
      steadyState = await measure();

      // ─── EXACTLY, FOR THIS FILE'S ROWS ─────────────────────────────────────
      // The 165 settled events produce nothing at all on a re-run.
      expect(await notesFor(), "a settled event was re-notified").toBe(notesBefore);

      // ─── AS A BUDGET, FOR THE WHOLE SWEEP ──────────────────────────────────
      // The endpoint is global and the rest of the suite is running against the
      // same database, so a genuinely new candidate belonging to another file
      // may legitimately be emitted during this sweep — at a handful of
      // statements each. What must not happen is a cost proportional to the
      // settled events. Pre-M3 those 165 alone cost 330 statements; the whole
      // per-event budget here is below that count.
      const perEventWork =
        steadyState.tally.claim + steadyState.tally.notification + steadyState.tally.emailState;
      expect(
        perEventWork,
        `steady-state per-event statements: ${describeTally(steadyState.tally)}`,
      ).toBeLessThan(ACTIVE_SCHEDULES);

      expect(steadyState.stats["skippedDuplicate"] as number).toBeGreaterThanOrEqual(
        ACTIVE_SCHEDULES,
      );
      expect(steadyState.ms).toBeLessThan(SCALE_DEADLINE_MS);
    },
  );
});

describe("M3 — batch boundaries neither skip nor duplicate a candidate", () => {
  it(
    "every candidate in a set spanning several pages is emitted exactly once",
    { timeout: 300_000 },
    async () => {
      // More than two page boundaries, so the keyset cursor has to tile the
      // candidate set correctly rather than happening to fit in one page.
      const eligible = 2 * CANDIDATE_BATCH_SIZE + 137;
      expect(eligible).toBeGreaterThan(2 * CANDIDATE_BATCH_SIZE);

      const { seed, res } = await withGlobalSweepExclusion(async () => {
        const seeded = await seedScaleFixtures(FIXTURES, {
          batch: "bound",
          inertJars: eligible,
          scheduleJars: 0,
        });

        // Make every one of them eligible for exactly one agreement reminder by
        // withdrawing the acceptances the seed created.
        await pool.query(
          `delete from agreement_acceptances aa
            using agreements a
            where aa.agreement_id = a.id and a.jar_id = any($1::uuid[])`,
          [seeded.inertJarIds],
        );

        const response = await request(app)
          .post(`${BASE}/internal/process-reminders`)
          .set("X-Internal-Token", INTERNAL_TOKEN);
        return { seed: seeded, res: response };
      });
      expect(res.status, JSON.stringify(res.body)).toBe(200);

      // Exactly one event per jar: none skipped at a boundary, none repeated.
      const emitted = await pool.query(
        `select count(*)::int as total, count(distinct r.jar_id)::int as jars
           from reminder_sent_events r
          where r.jar_id = any($1::uuid[]) and r.event_type = 'agreement_required'`,
        [seed.inertJarIds],
      );
      expect(emitted.rows[0].jars).toBe(eligible);
      expect(emitted.rows[0].total).toBe(eligible);

      // And the event keys are unique, which is what "exactly once" means at
      // the level the idempotency guarantee is stated.
      const distinctKeys = await pool.query(
        `select count(distinct event_key)::int c from reminder_sent_events
          where jar_id = any($1::uuid[]) and event_type = 'agreement_required'`,
        [seed.inertJarIds],
      );
      expect(distinctKeys.rows[0].c).toBe(eligible);
    },
  );
});
