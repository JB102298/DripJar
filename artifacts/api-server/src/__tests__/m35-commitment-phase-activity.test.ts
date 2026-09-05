/**
 * M3.5 — the commitment-phase activity is written once per jar, not once per run.
 *
 * ─── WHAT WAS WRONG ──────────────────────────────────────────────────────────
 *
 * A jar enters the Commitment phase once. The reminder processor logged that
 * fact on every invocation, because nothing recorded that it had already been
 * logged: the `alsoAfter` hook ran unconditionally, outside the branch that
 * skips a settled reminder, so preference, delivery outcome and duplicate
 * status made no difference — the row was written again regardless.
 *
 * In the development database that produced 57 641 `jar_commitment_phase` rows
 * across 283 jars: 90 % of the entire activity table, and one wasted INSERT per
 * settled jar on every run, for ever.
 *
 * ─── WHAT THIS FILE PINS ─────────────────────────────────────────────────────
 *
 * Idempotency now lives on the row itself — `activity_events.dedupe_key` under
 * a plain unique index (migration 0025) — which is what makes all of the
 * following true at once, and what a claim written before or after the activity
 * could not deliver:
 *
 *   - concurrent runs produce one row, because the database decides
 *   - a failed write leaves no claim, so the next run retries
 *   - a database error is never mistaken for "already logged"
 *   - a row migration 0025 already claimed is never duplicated
 *   - the historical duplicates are still there, untouched and still visible
 *
 * And the properties that had to survive unchanged: the organizer gating, the
 * independence from email preference, delivery and agreement acceptance, the
 * reminder event keys and stats, and the exact content of the activity itself.
 *
 * ─── WHY ONE SHARED POPULATION ───────────────────────────────────────────────
 *
 * `POST /internal/process-reminders` is global: one call sweeps every eligible
 * schedule and Saving jar in the database, and every caller in the suite
 * serialises on the same advisory lock. A file that calls it per test therefore
 * does not merely cost its own time — it queues ahead of every other file's
 * processor call and can starve their measurement windows.
 *
 * So the population is built once, three runs are taken in `beforeAll`, and the
 * per-property tests read the snapshots those runs produced. Only the three
 * properties that genuinely need their own sweep — ten-way contention, retry
 * after a failed write, and the steady-state statement count — take one.
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
import {
  acceptAgreement,
  financialFootprintFor,
  makeAgreement,
  makeJar,
  makeMember,
  makeUser,
  notificationsFor,
  reminderEventsFor,
  utcDay,
} from "./support/reminder-fixtures.js";
import { countQueries, describeTally } from "./support/query-counter.js";
import { activityDedupeKey, logActivityOnce } from "../lib/activity.js";

const BASE = "/api";
const INTERNAL_TOKEN = "m35-activity-internal-token";
const FIXTURES = createFixtureTag("m35act");

/** Overdue jars used only by the steady-state cost measurement. */
const COST_JARS = 12;

let orphanBaseline: OrphanBaseline;
const originalToken = process.env["INTERNAL_REMINDER_TOKEN"];

// ─── Helpers ─────────────────────────────────────────────────────────────────

const postProcessor = () =>
  request(app).post(`${BASE}/internal/process-reminders`).set("X-Internal-Token", INTERNAL_TOKEN);

/**
 * Run the global processor while holding the sweep lock.
 *
 * Every other processor caller in the suite takes the same hold, so this run
 * cannot interleave with one of theirs.
 */
const runProcessor = () => withGlobalSweepExclusion(() => postProcessor());

interface ActivityRow {
  id: string;
  jarId: string;
  userId: string | null;
  eventType: string;
  description: string;
  amountCents: number | null;
  metadata: unknown;
  dedupeKey: string | null;
  createdAt: Date;
}

/** Every activity row on a jar, oldest first. Includes the internal column. */
async function activityFor(jarId: string, eventType?: string): Promise<ActivityRow[]> {
  const res = await pool.query(
    `select id, jar_id as "jarId", user_id as "userId", event_type as "eventType",
            description, amount_cents as "amountCents", metadata,
            dedupe_key as "dedupeKey", created_at as "createdAt"
       from activity_events
      where jar_id = $1 ${eventType ? "and event_type = $2" : ""}
      order by created_at, id`,
    eventType ? [jarId, eventType] : [jarId],
  );
  return res.rows as ActivityRow[];
}

const phaseRows = (jarId: string) => activityFor(jarId, "jar_commitment_phase");
const phaseCount = async (jarId: string) => (await phaseRows(jarId)).length;

/**
 * The database's own clock, in the column's own representation.
 *
 * `activity_events.created_at` is `timestamp without time zone` filled by
 * `now()`, so it stores the server's local wall clock while the driver parses
 * it under the process TZ (UTC in this harness). Comparing it to a JS `Date`
 * measures that offset, not the behaviour under test. Reading the bound through
 * `now()::timestamp` puts both sides in the same representation.
 */
const dbNow = async (): Promise<Date> =>
  (await pool.query(`select now()::timestamp as t`)).rows[0].t as Date;

interface SeededJar {
  jarId: string;
  jarName: string;
  organizer: { userId: string };
  members: { userId: string }[];
}

/** An organizer-owned Saving jar with the given cutoff, plus extra members. */
async function seedJar(
  label: string,
  cutoffOffsetDays: number,
  opts: { members?: number; organizerCutoffPref?: boolean; organizerActive?: boolean } = {},
): Promise<SeededJar> {
  const organizer = await makeUser(FIXTURES, `${label}org`, {
    cutoffReminders: opts.organizerCutoffPref ?? true,
  });
  const jar = await makeJar(FIXTURES, organizer.userId, label, {
    cutoffDate: utcDay(cutoffOffsetDays),
  });
  await makeMember(jar.jarId, organizer.userId, {
    role: "organizer",
    status: opts.organizerActive === false ? "removed" : "active",
  });

  const members: { userId: string }[] = [];
  for (let i = 0; i < (opts.members ?? 0); i++) {
    const m = await makeUser(FIXTURES, `${label}m${i}`);
    await makeMember(jar.jarId, m.userId);
    members.push(m);
  }

  return { organizer, members, ...jar };
}

/**
 * Reproduce what migration 0025 leaves behind on a jar that had accumulated
 * duplicates: one elected canonical row carrying the key, and every surplus row
 * still present with a NULL key.
 */
async function seedMigratedHistory(jar: SeededJar, cutoff: string, duplicates: number) {
  const description = `${jar.jarName} has entered the Commitment phase (cutoff: ${cutoff})`;
  await pool.query(
    `insert into activity_events (jar_id, event_type, description, dedupe_key, created_at)
     values ($1, 'jar_commitment_phase', $2, $3, now() - interval '10 days')`,
    [jar.jarId, description, activityDedupeKey.jarCommitmentPhase(jar.jarId)],
  );
  for (let i = 0; i < duplicates; i++) {
    await pool.query(
      `insert into activity_events (jar_id, event_type, description, created_at)
       values ($1, 'jar_commitment_phase', $2, now() - interval '9 days')`,
      [jar.jarId, description],
    );
  }
  return description;
}

// ─── The population ──────────────────────────────────────────────────────────
//
// Seeded once, then swept three times. Snapshots are taken between the runs so
// the per-property tests can assert what each run did without sweeping again.

const pop = {} as {
  before: SeededJar;
  entry: SeededJar;
  missed: SeededJar;
  manyMembers: SeededJar;
  noOrganizer: SeededJar;
  accepted: SeededJar;
  prefOff: SeededJar;
  legacy: SeededJar;
  legacyDescription: string;
  content: SeededJar;
  privacy: SeededJar;
  keys: SeededJar;
  cost: SeededJar[];
};

/** Commitment-phase row counts for every population jar, after each run. */
let afterRun1: Map<string, number>;
let afterRun2: Map<string, number>;
let afterRun3: Map<string, number>;
let contentWindow: { before: Date; after: Date };
let run3Stats: Record<string, unknown>;

const allJars = (): SeededJar[] => [
  pop.before,
  pop.entry,
  pop.missed,
  pop.manyMembers,
  pop.noOrganizer,
  pop.accepted,
  pop.prefOff,
  pop.legacy,
  pop.content,
  pop.privacy,
  pop.keys,
  ...pop.cost,
];

async function countAll(): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const jar of allJars()) out.set(jar.jarId, await phaseCount(jar.jarId));
  return out;
}

beforeAll(async () => {
  orphanBaseline = await captureOrphanBaseline();
  process.env["INTERNAL_REMINDER_TOKEN"] = INTERNAL_TOKEN;

  pop.before = await seedJar("before", 3);
  pop.entry = await seedJar("entry", 0);
  pop.missed = await seedJar("missed", -35);
  pop.manyMembers = await seedJar("manymem", -1, { members: 3 });
  pop.noOrganizer = await seedJar("noorg", -1, { members: 1, organizerActive: false });
  pop.accepted = await seedJar("accepted", -1, { members: 2 });
  pop.prefOff = await seedJar("prefoff", -1, { organizerCutoffPref: false });
  pop.legacy = await seedJar("legacy", -6);
  pop.content = await seedJar("content", -1);
  pop.privacy = await seedJar("privacy", -1);
  pop.keys = await seedJar("keys", -1, { members: 1 });
  pop.cost = [];
  for (let i = 0; i < COST_JARS; i++) pop.cost.push(await seedJar(`cost${i}`, -3));

  // Everyone in the "accepted" jar has signed, so nobody there needs an
  // agreement reminder — the activity must not depend on one.
  const agreementId = await makeAgreement(pop.accepted.jarId);
  for (const userId of [
    pop.accepted.organizer.userId,
    ...pop.accepted.members.map((m) => m.userId),
  ]) {
    await acceptAgreement(agreementId, userId);
  }

  pop.legacyDescription = await seedMigratedHistory(pop.legacy, utcDay(-6), 6);

  // ── Three sweeps, with a snapshot after each ────────────────────────────────
  contentWindow = { before: await dbNow(), after: new Date(0) };
  const first = await runProcessor();
  expect(first.status, JSON.stringify(first.body)).toBe(200);
  contentWindow.after = await dbNow();
  afterRun1 = await countAll();

  const second = await runProcessor();
  expect(second.status, JSON.stringify(second.body)).toBe(200);
  afterRun2 = await countAll();

  const third = await runProcessor();
  expect(third.status, JSON.stringify(third.body)).toBe(200);
  run3Stats = third.body as Record<string, unknown>;
  afterRun3 = await countAll();
}, 240_000);

afterAll(async () => {
  await teardownFixtures(FIXTURES, {
    baseline: orphanBaseline,
    restore: () => {
      if (originalToken !== undefined) process.env["INTERNAL_REMINDER_TOKEN"] = originalToken;
      else delete process.env["INTERNAL_REMINDER_TOKEN"];
    },
  });
});

// ─── 1–3. When the activity appears at all ───────────────────────────────────

describe("M3.5 — the activity appears exactly at commitment-phase entry", () => {
  it("writes nothing while the jar is still before its cutoff", () => {
    expect(afterRun1.get(pop.before.jarId)).toBe(0);
    expect(afterRun3.get(pop.before.jarId)).toBe(0);
  });

  it("writes exactly one row on the run that first sees the cutoff reached", () => {
    expect(afterRun1.get(pop.entry.jarId)).toBe(1);
  });

  it("still writes exactly one when the transition day itself was missed", async () => {
    // The jar crossed its cutoff five weeks ago and no processor had ever seen
    // it. A key built from the run date would have produced nothing here (or a
    // fresh row every day); the key is built from the jar.
    expect(afterRun1.get(pop.missed.jarId)).toBe(1);

    const rows = await phaseRows(pop.missed.jarId);
    expect(rows[0]!.dedupeKey).toBe(`jar_commitment_phase:${pop.missed.jarId}`);
  });
});

// ─── 4–7. Repetition and scope ───────────────────────────────────────────────

describe("M3.5 — repetition and scope", () => {
  it("leaves exactly one row after every repeated run", () => {
    for (const jar of [pop.entry, pop.missed, pop.content, pop.privacy]) {
      expect(afterRun1.get(jar.jarId), `${jar.jarName} run 1`).toBe(1);
      expect(afterRun2.get(jar.jarId), `${jar.jarName} run 2`).toBe(1);
      expect(afterRun3.get(jar.jarId), `${jar.jarName} run 3`).toBe(1);
    }
  });

  it("gives each of several jars its own single row", () => {
    for (const jar of pop.cost) {
      expect(afterRun3.get(jar.jarId), jar.jarName).toBe(1);
    }
    // Distinct jars, distinct keys — not one row shared between them.
    expect(new Set(pop.cost.map((j) => j.jarId)).size).toBe(COST_JARS);
  });

  it("writes one jar-level row however many members the jar has", async () => {
    expect(afterRun3.get(pop.manyMembers.jarId)).toBe(1);

    // The reminder itself is still per-recipient: four active members, four
    // cutoff_reached events. Only the activity is jar-level.
    const events = await reminderEventsFor([
      pop.manyMembers.organizer.userId,
      ...pop.manyMembers.members.map((m) => m.userId),
    ]);
    expect(events.filter((e) => e.eventType === "cutoff_reached")).toHaveLength(4);
  });

  it("ten concurrent processors leave exactly one row", async () => {
    // The jar is created inside the sweep hold and consumed by the very next
    // statement, so these ten calls are guaranteed to be the first sweep that
    // sees it. They are NOT serialised against each other — they share the one
    // hold, which is what puts them in genuine contention on the unique index.
    const { jar, responses } = await withGlobalSweepExclusion(async () => {
      const j = await seedJar("tenway", -1);
      const res = await Promise.all(Array.from({ length: 10 }, () => postProcessor()));
      return { jar: j, responses: res };
    });

    for (const res of responses) expect(res.status, JSON.stringify(res.body)).toBe(200);

    const rows = await phaseRows(jar.jarId);
    expect(rows, "concurrent processors wrote more than one activity").toHaveLength(1);
    expect(rows[0]!.dedupeKey).toBe(`jar_commitment_phase:${jar.jarId}`);
  }, 180_000);
});

// ─── 8–10. The gating that had to stay exactly as it was ─────────────────────

describe("M3.5 — existing gating and independence are unchanged", () => {
  it("writes nothing when the organizer is not an active member, but still reminds the rest", async () => {
    expect(afterRun3.get(pop.noOrganizer.jarId)).toBe(0);

    const memberEvents = await reminderEventsFor([pop.noOrganizer.members[0]!.userId]);
    expect(memberEvents.map((e) => e.eventType)).toContain("cutoff_reached");
  });

  it("is unaffected by every member having accepted the agreement", async () => {
    expect(afterRun1.get(pop.accepted.jarId)).toBe(1);
    expect(afterRun3.get(pop.accepted.jarId)).toBe(1);

    // Nobody needs an agreement reminder, and the activity did not depend on one.
    const events = await reminderEventsFor([pop.accepted.organizer.userId]);
    expect(events.map((e) => e.eventType)).not.toContain("agreement_required");
  });

  it("is unaffected by the organizer having cutoff emails disabled", async () => {
    expect(afterRun1.get(pop.prefOff.jarId)).toBe(1);
    expect(afterRun3.get(pop.prefOff.jarId)).toBe(1);

    // The reminder took the terminal preference-skip path — the branch that
    // skips `processReminderEvent` entirely on later runs — and the activity was
    // written anyway.
    const events = await reminderEventsFor([pop.prefOff.organizer.userId]);
    const cutoffReached = events.find((e) => e.eventType === "cutoff_reached");
    expect(cutoffReached?.emailStatus).toBe("skipped_preference");
  });
});

// ─── 11–12. Legacy rows migration 0025 already dealt with ────────────────────

describe("M3.5 — history is honoured and left alone", () => {
  it("adds no duplicate to a jar whose canonical row migration 0025 already claimed", () => {
    // One claimed row plus six unclaimed duplicates, and three sweeps later it
    // is still exactly those seven.
    expect(afterRun1.get(pop.legacy.jarId)).toBe(7);
    expect(afterRun3.get(pop.legacy.jarId), "the processor added a duplicate").toBe(7);
  });

  it("leaves every historical duplicate present, unchanged, and visible in the feed", async () => {
    const rows = await phaseRows(pop.legacy.jarId);
    expect(rows).toHaveLength(7);

    // Exactly one carries the key; the rest are unclaimed and still there.
    expect(rows.filter((r) => r.dedupeKey !== null)).toHaveLength(1);
    expect(rows.filter((r) => r.dedupeKey === null)).toHaveLength(6);
    for (const row of rows) {
      expect(row.description).toBe(pop.legacyDescription);
      expect(row.userId).toBeNull();
    }

    // And they are all still readable through the API, not hidden or merged.
    const reader = await request(app).post(`${BASE}/auth/register`).send({
      email: FIXTURES.email("visiblereader"),
      password: "P@ssword1!",
      firstName: "Vis",
      lastName: "Reader",
    });
    expect(reader.status).toBe(201);
    await makeMember(pop.legacy.jarId, reader.body.user.id as string);

    const feed = await request(app)
      .get(`${BASE}/jars/${pop.legacy.jarId}/activity?limit=50`)
      .set({ Authorization: `Bearer ${reader.body.token as string}` });
    expect(feed.status).toBe(200);
    const phaseEntries = (feed.body as { eventType: string; description: string }[]).filter(
      (e) => e.eventType === "jar_commitment_phase",
    );
    expect(phaseEntries).toHaveLength(7);
    for (const entry of phaseEntries) expect(entry.description).toBe(pop.legacyDescription);
  });
});

// ─── 13–14. Failure is failure, never "already logged" ───────────────────────

describe("M3.5 — a failed write is retried, not recorded as done", () => {
  /**
   * Fail the activity INSERT that carries `dedupeKey`, and only that one.
   *
   * Matching on the statement text alone is not enough: the processor is global,
   * so under full-suite load the first activity insert it issues may well belong
   * to another file's jar. The parameter list is what makes the injection
   * precise.
   */
  function failActivityInsertFor(dedupeKey: string) {
    const original = pool.query.bind(pool) as (...args: unknown[]) => unknown;
    const state = { hit: false };
    (pool as unknown as { query: unknown }).query = function patched(...args: unknown[]) {
      const first = args[0];
      const text = typeof first === "string" ? first : ((first as { text?: string })?.text ?? "");
      const values = Array.isArray(args[1])
        ? (args[1] as unknown[])
        : ((first as { values?: unknown[] })?.values ?? []);
      if (
        !state.hit &&
        /insert into "activity_events"/i.test(text) &&
        values.some((v) => v === dedupeKey)
      ) {
        state.hit = true;
        return Promise.reject(
          Object.assign(new Error("connection terminated unexpectedly"), { code: "57P01" }),
        );
      }
      return original(...args);
    };
    return {
      state,
      restore: () => {
        (pool as unknown as { query: unknown }).query = original;
      },
    };
  }

  it("writes exactly one row when the first attempt fails and a later run retries", async () => {
    const jar = await seedJar("retry", -1);
    const key = activityDedupeKey.jarCommitmentPhase(jar.jarId);

    const injection = failActivityInsertFor(key);
    let firstRunStatus: number;
    try {
      const res = await runProcessor();
      firstRunStatus = res.status;
    } finally {
      injection.restore();
    }

    expect(injection.state.hit, "the injected failure never reached this jar's insert").toBe(true);
    // Activity logging is non-critical to the reminder run, exactly as before.
    expect(firstRunStatus).toBe(200);
    // Nothing was written, and — crucially — nothing was claimed either.
    expect(await phaseCount(jar.jarId)).toBe(0);

    await runProcessor();
    expect(await phaseCount(jar.jarId), "the retry did not write the activity").toBe(1);
  }, 180_000);

  it("propagates an unexpected database error instead of reporting 'already-logged'", async () => {
    const jar = await seedJar("dberror", 30);
    const key = activityDedupeKey.jarCommitmentPhase(jar.jarId);

    const injection = failActivityInsertFor(key);
    let outcome: unknown;
    let error: unknown;
    try {
      outcome = await logActivityOnce({
        dedupeKey: key,
        jarId: jar.jarId,
        eventType: "jar_commitment_phase",
        description: "should not survive",
      });
    } catch (err) {
      error = err;
    } finally {
      injection.restore();
    }

    expect(injection.state.hit).toBe(true);
    expect(outcome, "a database failure was reported as a successful outcome").toBeUndefined();
    expect(error).toBeDefined();
    expect(await phaseCount(jar.jarId)).toBe(0);
  });

  it("reports 'created' once and 'already-logged' thereafter", async () => {
    // Cutoff far in the future, so no processor run can interfere with the
    // outcomes this test asserts.
    const jar = await seedJar("outcome", 60);
    const write = () =>
      logActivityOnce({
        dedupeKey: activityDedupeKey.jarCommitmentPhase(jar.jarId),
        jarId: jar.jarId,
        eventType: "jar_commitment_phase",
        description: `${jar.jarName} has entered the Commitment phase (cutoff: ${utcDay(60)})`,
      });

    expect(await write()).toBe("created");
    expect(await write()).toBe("already-logged");

    // Ten at once: none can create, because one already did.
    const outcomes = await Promise.all(Array.from({ length: 10 }, write));
    expect(outcomes.every((o) => o === "already-logged")).toBe(true);
    expect(await phaseCount(jar.jarId)).toBe(1);
  });

  it("resolves ten simultaneous first writes to exactly one row", async () => {
    // The same contention as the ten-processor test, but with no reminder
    // machinery in the way: ten callers race from a standing start on a key
    // nobody holds. Exactly one may create.
    const jar = await seedJar("racewrite", 60);
    const write = () =>
      logActivityOnce({
        dedupeKey: activityDedupeKey.jarCommitmentPhase(jar.jarId),
        jarId: jar.jarId,
        eventType: "jar_commitment_phase",
        description: "ten-way first write",
      });

    const outcomes = await Promise.all(Array.from({ length: 10 }, write));
    expect(outcomes.filter((o) => o === "created")).toHaveLength(1);
    expect(outcomes.filter((o) => o === "already-logged")).toHaveLength(9);
    expect(await phaseCount(jar.jarId)).toBe(1);
  });
});

// ─── 15–17. Content, privacy, and the absence of side effects ────────────────

describe("M3.5 — the activity itself is unchanged", () => {
  it("keeps its actor, jar, type, description, amount, metadata and timestamp semantics", async () => {
    const cutoff = utcDay(-1);
    const rows = await phaseRows(pop.content.jarId);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;

    expect(row.jarId).toBe(pop.content.jarId);
    // A jar-level system event has no actor, exactly as before M3.5.
    expect(row.userId).toBeNull();
    expect(row.eventType).toBe("jar_commitment_phase");
    expect(row.description).toBe(
      `${pop.content.jarName} has entered the Commitment phase (cutoff: ${cutoff})`,
    );
    expect(row.amountCents).toBeNull();
    expect(row.metadata).toBeNull();

    // Database-generated, during the first sweep — the observation time, not
    // the cutoff date and not a client clock.
    expect(row.createdAt.getTime()).toBeGreaterThanOrEqual(contentWindow.before.getTime());
    expect(row.createdAt.getTime()).toBeLessThanOrEqual(contentWindow.after.getTime());
    expect(row.createdAt.toISOString().slice(0, 10)).not.toBe(cutoff);
  });

  it("freezes the row: later runs neither replace it nor move its timestamp", async () => {
    // Before M3.5 every run appended a row with a fresh timestamp, so the entry
    // the feed showed kept moving. Three sweeps have happened by now.
    const rows = await phaseRows(pop.entry.jarId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.createdAt.getTime()).toBeLessThanOrEqual(contentWindow.after.getTime());
    expect(rows[0]!.dedupeKey).toBe(`jar_commitment_phase:${pop.entry.jarId}`);
  });

  it("never returns dedupe_key to a client", async () => {
    expect(afterRun3.get(pop.privacy.jarId)).toBe(1);

    const reader = await request(app).post(`${BASE}/auth/register`).send({
      email: FIXTURES.email("privacyreader"),
      password: "P@ssword1!",
      firstName: "Priv",
      lastName: "Reader",
    });
    expect(reader.status).toBe(201);
    await makeMember(pop.privacy.jarId, reader.body.user.id as string);
    const auth = { Authorization: `Bearer ${reader.body.token as string}` };

    for (const path of [
      `/jars/${pop.privacy.jarId}/activity?limit=50`,
      `/activity`,
      `/dashboard`,
    ]) {
      const res = await request(app).get(`${BASE}${path}`).set(auth);
      expect(res.status, path).toBe(200);
      const body = JSON.stringify(res.body);
      expect(body, `${path} leaked the internal key name`).not.toMatch(/dedupe_?[Kk]ey/);
      expect(body, `${path} leaked a key value`).not.toContain(
        activityDedupeKey.jarCommitmentPhase(pop.privacy.jarId),
      );
    }

    // The entry is present — the assertions above are not passing vacuously.
    const feed = await request(app)
      .get(`${BASE}/jars/${pop.privacy.jarId}/activity?limit=50`)
      .set(auth);
    expect(
      (feed.body as { eventType: string }[]).filter((e) => e.eventType === "jar_commitment_phase"),
    ).toHaveLength(1);
  });

  it("creates no email, notification, contribution, or ledger row of its own", async () => {
    // Cutoff far out, so nothing else in the suite can touch this jar.
    const jar = await seedJar("sideeffect", 90);

    const financialBefore = await financialFootprintFor([jar.jarId]);
    const notesBefore = await notificationsFor([jar.organizer.userId]);
    const eventsBefore = await reminderEventsFor([jar.organizer.userId]);

    // The writer in isolation — no reminder machinery involved at all.
    expect(
      await logActivityOnce({
        dedupeKey: activityDedupeKey.jarCommitmentPhase(jar.jarId),
        jarId: jar.jarId,
        eventType: "jar_commitment_phase",
        description: "isolated write",
      }),
    ).toBe("created");

    expect(await phaseCount(jar.jarId)).toBe(1);
    expect(await financialFootprintFor([jar.jarId])).toEqual(financialBefore);
    expect(await notificationsFor([jar.organizer.userId])).toEqual(notesBefore);
    expect(await reminderEventsFor([jar.organizer.userId])).toEqual(eventsBefore);
  });
});

// ─── 18. The reminder machinery is untouched ─────────────────────────────────

describe("M3.5 — reminder keys, types and stats are unchanged", () => {
  it("adds no row, key or type to the reminder event ledger", async () => {
    const userIds = [pop.keys.organizer.userId, ...pop.keys.members.map((m) => m.userId)];
    const events = await reminderEventsFor(userIds);

    // Exactly the reminders the cutoff produces — the activity claim lives on
    // the activity row, not here, so nothing new appears in this ledger.
    expect(events.map((e) => e.eventType).sort()).toEqual(["cutoff_reached", "cutoff_reached"]);
    for (const e of events) {
      expect(e.eventKey).toBe(`cutoff_reached:${pop.keys.jarId}:${utcDay(-1)}:${e.userId}`);
      expect(e.jarId).toBe(pop.keys.jarId);
    }

    const strays = await pool.query(
      `select count(*)::int c from reminder_sent_events where event_type like 'jar_commitment%'`,
    );
    expect(strays.rows[0].c, "an activity claim leaked into reminder_sent_events").toBe(0);
  });

  it("still reports the settled reminders as duplicates on a re-run", () => {
    // Other files contribute to this global counter; ours can only add to it.
    expect(run3Stats["skippedDuplicate"] as number).toBeGreaterThanOrEqual(1);
    expect(run3Stats).toHaveProperty("cutoffReachedSent");
    expect(run3Stats).toHaveProperty("agreementRequiredSent");
    expect(run3Stats).toHaveProperty("runAt");
  });
});

// ─── 19–20. The cost, which is what started all this ─────────────────────────

describe("M3.5 — steady-state cost does not scale with settled jars", () => {
  it("issues no activity insert per settled jar on a re-run", async () => {
    // The twelve cost jars were claimed by the population sweeps above.
    for (const jar of pop.cost) expect(afterRun3.get(jar.jarId), jar.jarName).toBe(1);

    // Steady state. `countQueries` patches this process's pool only, and Vitest
    // forks a process per file, so the tally is this run's statements — but the
    // endpoint is global, so other files' jars may legitimately contribute a
    // few. What must not happen is a cost proportional to settled jars: before
    // M3.5 these twelve alone cost twelve INSERTs on every single run.
    const { result, tally } = await countQueries(() => runProcessor());
    expect(result.status, JSON.stringify(result.body)).toBe(200);

    const activityInserts = tally.statements.filter((s) =>
      /insert into "activity_events"/i.test(s),
    ).length;
    const activitySelects = tally.statements.filter((s) =>
      /select .*from "activity_events"/is.test(s),
    ).length;

    expect(
      activityInserts,
      `steady-state activity inserts scaled with settled jars — ${describeTally(tally)}`,
    ).toBeLessThan(COST_JARS);

    // The prefetch is per PAGE, not per jar. CANDIDATE_BATCH_SIZE is 500, so a
    // suite-sized database is a handful of pages at most.
    expect(
      activitySelects,
      `activity prefetch issued per jar rather than per page — ${describeTally(tally)}`,
    ).toBeLessThan(COST_JARS);

    for (const jar of pop.cost) expect(await phaseCount(jar.jarId), jar.jarName).toBe(1);
  }, 180_000);
});
