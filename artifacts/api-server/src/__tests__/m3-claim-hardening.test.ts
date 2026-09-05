/**
 * M3 — claim and idempotency hardening.
 *
 * ─── WHAT WAS WRONG ──────────────────────────────────────────────────────────
 *
 * `claimOrFetchEvent` used to be:
 *
 *     try { INSERT … RETURNING }
 *     catch { SELECT … WHERE event_key = ? }
 *
 * The comment on the catch said "UNIQUE constraint violation". The catch itself
 * said no such thing: it took every failure the insert could produce. A foreign
 * key violation from a deleted user, a dropped connection, a permission error, a
 * serialisation failure — each was reinterpreted as "already claimed", and the
 * SELECT that followed then found nothing, so the function returned
 * `row: undefined` typed as a `ReminderRow` and the caller dereferenced it.
 *
 * It is now `ON CONFLICT (event_key) DO NOTHING … RETURNING`: the database
 * decides, exactly, whether the intended uniqueness conflict occurred. This
 * file pins all four consequences — the conflict path still works, other errors
 * propagate, a vanished row fails loudly, and none of it weakened the
 * concurrency guarantees the delivery state machine rests on.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { pool, db, reminderSentEvents } from "@workspace/db";
import { eq } from "drizzle-orm";
import app from "../app.js";
import {
  captureOrphanBaseline,
  createFixtureTag,
  teardownFixtures,
  withGlobalSweepExclusion,
  type OrphanBaseline,
} from "./support/fixtures.js";
import {
  makeJar,
  makeMember,
  makeSchedule,
  makeUser,
  notificationsFor,
  reminderEventsFor,
  utcDay,
} from "./support/reminder-fixtures.js";
import {
  atomicClaimEmailAttempt,
  claimOrFetchEvent,
  ReminderEventVanishedError,
} from "../routes/reminders.js";

const BASE = "/api";
const INTERNAL_TOKEN = "m3-claim-internal-token";
const FIXTURES = createFixtureTag("m3claim");

let orphanBaseline: OrphanBaseline;
const originalToken = process.env["INTERNAL_REMINDER_TOKEN"];

/** An account and jar this file owns, for events that need real foreign keys. */
let owner: { userId: string; email: string };
let ownedJarId: string;

beforeAll(async () => {
  orphanBaseline = await captureOrphanBaseline();
  process.env["INTERNAL_REMINDER_TOKEN"] = INTERNAL_TOKEN;
  owner = await makeUser(FIXTURES, "claimowner");
  const jar = await makeJar(FIXTURES, owner.userId, "claimjar");
  ownedJarId = jar.jarId;
  await makeMember(ownedJarId, owner.userId, { role: "organizer" });
}, 60_000);

afterAll(async () => {
  await teardownFixtures(FIXTURES, {
    baseline: orphanBaseline,
    restore: () => {
      if (originalToken !== undefined) process.env["INTERNAL_REMINDER_TOKEN"] = originalToken;
      else delete process.env["INTERNAL_REMINDER_TOKEN"];
    },
  });
});

/**
 * The SQLSTATE of a rejection, wherever drizzle put it.
 *
 * drizzle-orm wraps a driver failure in a `DrizzleQueryError` carrying the
 * statement and its parameters, with the `pg` error as `cause`. The point of
 * these tests is that the failure *propagates* rather than being reinterpreted
 * as a duplicate, so the assertion reads the code through the wrapper instead
 * of depending on which layer surfaced it.
 */
function pgCodeOf(err: unknown): string | undefined {
  let current: unknown = err;
  for (let depth = 0; depth < 6 && current; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected the call to reject, but it resolved");
}

const uniqueKey = (label: string) => `m3claim:${label}:${FIXTURES.tag}:${Math.random().toString(36).slice(2, 10)}`;

// ─── The intended conflict ───────────────────────────────────────────────────

describe("M3 — the intended event-key conflict", () => {
  it("first call inserts and reports isNew; second call retrieves the same row", async () => {
    const eventKey = uniqueKey("conflict");
    const first = await claimOrFetchEvent({
      eventKey, userId: owner.userId, jarId: ownedJarId, eventType: "contribution_due",
    });
    expect(first.isNew).toBe(true);
    expect(first.row.eventKey).toBe(eventKey);
    expect(first.row.emailStatus).toBe("pending");

    const second = await claimOrFetchEvent({
      eventKey, userId: owner.userId, jarId: ownedJarId, eventType: "contribution_due",
    });
    expect(second.isNew).toBe(false);
    expect(second.row.id).toBe(first.row.id);
    expect(second.row).toBeDefined();
  });

  it("the conflict re-fetch never yields an undefined row", async () => {
    const eventKey = uniqueKey("defined");
    await claimOrFetchEvent({ eventKey, userId: owner.userId, jarId: ownedJarId, eventType: "cutoff_reached" });
    for (let i = 0; i < 5; i++) {
      const again = await claimOrFetchEvent({
        eventKey, userId: owner.userId, jarId: ownedJarId, eventType: "cutoff_reached",
      });
      expect(again.row).not.toBeUndefined();
      expect(again.row.eventKey).toBe(eventKey);
    }
  });

  it("a conflicting insert leaves the stored row untouched", async () => {
    const eventKey = uniqueKey("untouched");
    const { row } = await claimOrFetchEvent({
      eventKey, userId: owner.userId, jarId: ownedJarId, eventType: "agreement_required",
    });
    await db
      .update(reminderSentEvents)
      .set({ emailStatus: "sent", emailSentAt: new Date(), emailAttemptCount: 3 })
      .where(eq(reminderSentEvents.id, row.id));

    const after = await claimOrFetchEvent({
      // Different jar and type on purpose: a conflicting insert must not
      // overwrite anything, so the stored values must be the earlier ones.
      eventKey, userId: owner.userId, jarId: null, eventType: "contribution_missed",
    });
    expect(after.isNew).toBe(false);
    expect(after.row.emailStatus).toBe("sent");
    expect(after.row.emailAttemptCount).toBe(3);
    expect(after.row.eventType).toBe("agreement_required");
    expect(after.row.jarId).toBe(ownedJarId);
  });

  it("concurrent claims on one key produce exactly one insert and one row", async () => {
    const eventKey = uniqueKey("race");
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        claimOrFetchEvent({
          eventKey, userId: owner.userId, jarId: ownedJarId, eventType: "contribution_due",
        }),
      ),
    );
    expect(results.filter((r) => r.isNew)).toHaveLength(1);
    const ids = new Set(results.map((r) => r.row.id));
    expect(ids.size).toBe(1);

    const stored = await pool.query(
      `select count(*)::int c from reminder_sent_events where event_key = $1`,
      [eventKey],
    );
    expect(stored.rows[0].c).toBe(1);
  });
});

// ─── Everything that is not that conflict ────────────────────────────────────

describe("M3 — non-unique database errors are rethrown, not read as duplicates", () => {
  const MISSING_USER = "00000000-0000-4000-8000-000000000001";
  const MISSING_JAR = "00000000-0000-4000-8000-000000000002";

  it("a foreign-key violation on user_id propagates", async () => {
    const err = await rejectionOf(
      claimOrFetchEvent({
        eventKey: uniqueKey("fkuser"),
        userId: MISSING_USER,
        jarId: ownedJarId,
        eventType: "contribution_due",
      }),
    );
    expect(pgCodeOf(err)).toBe("23503");
  });

  it("a foreign-key violation on jar_id propagates", async () => {
    const err = await rejectionOf(
      claimOrFetchEvent({
        eventKey: uniqueKey("fkjar"),
        userId: owner.userId,
        jarId: MISSING_JAR,
        eventType: "cutoff_upcoming",
      }),
    );
    expect(pgCodeOf(err)).toBe("23503");
  });

  it("a CHECK-constraint violation propagates rather than looking like a duplicate", async () => {
    // email_status is constrained to five literals. Writing a sixth is a 23514,
    // and the old bare catch would have swallowed it and then returned undefined.
    const err = await rejectionOf(
      pool.query(
        `insert into reminder_sent_events (event_key, user_id, jar_id, event_type, email_status)
         values ($1, $2, $3, 'contribution_due', 'not_a_status')`,
        [uniqueKey("check"), owner.userId, ownedJarId],
      ),
    );
    expect(pgCodeOf(err)).toBe("23514");
  });

  it("a failed insert leaves no row behind", async () => {
    const eventKey = uniqueKey("norow");
    await expect(
      claimOrFetchEvent({
        eventKey, userId: MISSING_USER, jarId: ownedJarId, eventType: "contribution_due",
      }),
    ).rejects.toBeTruthy();
    const stored = await pool.query(
      `select count(*)::int c from reminder_sent_events where event_key = $1`,
      [eventKey],
    );
    expect(stored.rows[0].c).toBe(0);
  });

  it("a rethrown claim error reaches the caller as a 500 rather than a silent success", { timeout: 60_000 }, async () => {
    // An eligible candidate this file owns, so the processor has something to
    // claim, and a claim insert that fails for a reason that is NOT the
    // event-key conflict. Before M3 this was swallowed and the run reported 200.
    // The candidate is created inside the sweep lock and consumed by the very
    // next statement, so no other test file's global sweep can settle it first
    // and leave this run with nothing to insert.
    const { injected, status } = await withGlobalSweepExclusion(async () => {
      const user = await makeUser(FIXTURES, "fivehundred");
      const jar = await makeJar(FIXTURES, user.userId, "fivehundredjar");
      const member = await makeMember(jar.jarId, user.userId, { role: "organizer" });
      await makeSchedule(jar.jarId, member, {
        frequency: "weekly", amountCents: 10_000, startDate: utcDay(0),
      });

      const original = pool.query.bind(pool) as (...args: unknown[]) => unknown;
      let hit = false;
      (pool as unknown as { query: unknown }).query = function patched(...args: unknown[]) {
        const first = args[0];
        const text = typeof first === "string" ? first : (first as { text?: string })?.text ?? "";
        if (!hit && /insert into "reminder_sent_events"/i.test(text)) {
          hit = true;
          const err = Object.assign(
            new Error('insert or update on table "reminder_sent_events" violates foreign key constraint'),
            { code: "23503", constraint: "reminder_sent_events_user_id_fkey" },
          );
          return Promise.reject(err);
        }
        return original(...args);
      };

      try {
        const res = await request(app)
          .post(`${BASE}/internal/process-reminders`)
          .set("X-Internal-Token", INTERNAL_TOKEN);
        return { injected: hit, status: res.status };
      } finally {
        (pool as unknown as { query: unknown }).query = original;
      }
    });

    expect(injected, "the injected failure never reached a reminder insert").toBe(true);
    expect(status).toBe(500);
  });
});

describe("M3 — a conflict whose row then vanishes fails explicitly", () => {
  it("raises ReminderEventVanishedError instead of returning undefined", async () => {
    const eventKey = uniqueKey("vanish");
    await claimOrFetchEvent({
      eventKey, userId: owner.userId, jarId: ownedJarId, eventType: "contribution_due",
    });

    // Reproduce the interleaving exactly: the row exists when the INSERT runs,
    // so the insert conflicts and returns nothing — and it is gone by the time
    // the follow-up SELECT executes. The delete is issued between the two
    // statements rather than before them, which is what makes this the race
    // and not merely a missing row.
    const original = pool.query.bind(pool) as (...args: unknown[]) => unknown;
    let deleted = false;
    (pool as unknown as { query: unknown }).query = async function patched(...args: unknown[]) {
      const first = args[0];
      const text = typeof first === "string" ? first : (first as { text?: string })?.text ?? "";
      const result = await (original(...args) as Promise<unknown>);
      if (!deleted && /insert into "reminder_sent_events"/i.test(text)) {
        deleted = true;
        await original(`delete from reminder_sent_events where event_key = $1`, [eventKey]);
      }
      return result;
    };

    let error: unknown;
    try {
      await claimOrFetchEvent({
        eventKey, userId: owner.userId, jarId: ownedJarId, eventType: "contribution_due",
      });
    } catch (err) {
      error = err;
    } finally {
      (pool as unknown as { query: unknown }).query = original;
    }

    expect(deleted, "the injected delete never ran").toBe(true);
    expect(error).toBeInstanceOf(ReminderEventVanishedError);
    expect((error as ReminderEventVanishedError).eventKey).toBe(eventKey);
    expect((error as Error).message).toContain(eventKey);
  });
});

// ─── Retry eligibility is unchanged ──────────────────────────────────────────

describe("M3 — retry and stale-claim behaviour is unchanged", () => {
  const insertEvent = async (status: string, lastAttemptAt: Date | null, attempts = 0) => {
    const res = await pool.query(
      `insert into reminder_sent_events
         (event_key, user_id, jar_id, event_type, email_status, email_attempt_count, email_last_attempt_at)
       values ($1, $2, $3, 'contribution_due', $4, $5, $6) returning id`,
      [uniqueKey(`retry${status}`), owner.userId, ownedJarId, status, attempts, lastAttemptAt],
    );
    return res.rows[0].id as string;
  };

  it("a failed row is claimable and its attempt count advances", async () => {
    const id = await insertEvent("failed", new Date(Date.now() - 600_000), 2);
    const claimed = await atomicClaimEmailAttempt(id);
    expect(claimed).not.toBeNull();
    expect(claimed!.emailStatus).toBe("sending");
    expect(claimed!.emailAttemptCount).toBe(3);
  });

  it("a pending row is claimable exactly once under concurrency", async () => {
    const id = await insertEvent("pending", null);
    const winners = (await Promise.all(
      Array.from({ length: 6 }, () => atomicClaimEmailAttempt(id)),
    )).filter(Boolean);
    expect(winners).toHaveLength(1);
    expect(winners[0]!.emailAttemptCount).toBe(1);
  });

  it("a sent row is never claimable again", async () => {
    const id = await insertEvent("sent", new Date());
    expect(await atomicClaimEmailAttempt(id)).toBeNull();
  });

  it("a skipped_preference row is never claimable again", async () => {
    const id = await insertEvent("skipped_preference", new Date());
    expect(await atomicClaimEmailAttempt(id)).toBeNull();
  });

  it("a fresh 'sending' row belongs to its owner and is not stolen", async () => {
    const id = await insertEvent("sending", new Date(), 1);
    expect(await atomicClaimEmailAttempt(id)).toBeNull();
  });

  it("a stale 'sending' row is reclaimed after the stale window", async () => {
    const id = await insertEvent("sending", new Date(Date.now() - 600_000), 1);
    const claimed = await atomicClaimEmailAttempt(id);
    expect(claimed).not.toBeNull();
    expect(claimed!.emailAttemptCount).toBe(2);
  });
});

// ─── Ten simultaneous processor calls ────────────────────────────────────────

describe("M3 — simultaneous processor invocations", () => {
  it(
    "ten concurrent calls produce one event, one notification and one successful send",
    { timeout: 180_000 },
    async () => {
      // One lock for the fixture and the whole burst. It keeps another file's
      // teardown out of the scan, and — because the candidate is created under
      // the same hold — guarantees that these ten calls are the first sweep to
      // see it. The ten calls are NOT serialised against each other: they share
      // the single hold, which is what puts them in genuine contention.
      const { user, scheduleId, responses } = await withGlobalSweepExclusion(async () => {
        const u = await makeUser(FIXTURES, "tenway");
        const jar = await makeJar(FIXTURES, u.userId, "tenwayjar");
        const member = await makeMember(jar.jarId, u.userId, { role: "organizer" });
        const sched = await makeSchedule(jar.jarId, member, {
          frequency: "weekly", amountCents: 10_000, startDate: utcDay(0),
        });
        const res = await Promise.all(
          Array.from({ length: 10 }, () =>
            request(app)
              .post(`${BASE}/internal/process-reminders`)
              .set("X-Internal-Token", INTERNAL_TOKEN),
          ),
        );
        return { user: u, scheduleId: sched, responses: res };
      });

      for (const res of responses) {
        expect(res.status, JSON.stringify(res.body)).toBe(200);
      }

      const events = await reminderEventsFor([user.userId]);
      expect(events).toHaveLength(1);
      expect(events[0]!.eventKey).toBe(
        `contribution_due:${scheduleId}:${new Date().toISOString().slice(0, 10)}`,
      );
      expect(events[0]!.emailStatus).toBe("sent");
      // Exactly one processor won the atomic claim; the other nine saw a fresh
      // 'sending' row and stood down without incrementing anything.
      expect(events[0]!.emailAttemptCount).toBe(1);
      expect(events[0]!.emailSentAt).not.toBeNull();

      const notes = await notificationsFor([user.userId]);
      expect(notes).toHaveLength(1);
      expect(notes[0]!.type).toBe("contribution_due");

      // ─── WHICH RESPONSE GETS THE CREDIT ────────────────────────────────
      //
      // Under real concurrency the process that wins the INSERT and the process
      // that wins the email claim need not be the same one. The inserter sees
      // `isNew = true`, writes the notification, then finds the row already in
      // 'sending' and stands down; the claimer saw `isNew = false`, so it
      // reports its successful delivery as `emailRetried` rather than
      // `contributionDueSent`. Both buckets therefore have to be counted to
      // see the one delivery that happened.
      //
      // That classification split is pre-M3 behaviour and is deliberately
      // unchanged here — the response contract is not being altered for
      // performance work. What the delivery *effects* are is asserted above,
      // from the database, where it is exact.
      const deliveriesReported = responses.reduce(
        (n, r) => n + (r.body.contributionDueSent as number) + (r.body.emailRetried as number),
        0,
      );
      expect(deliveriesReported).toBeGreaterThanOrEqual(1);
    },
  );
});
