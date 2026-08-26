/**
 * Phase 2B2 — Notification read surface.
 *
 * Proves the properties the notification UX now depends on:
 *
 *   - the unread total is the CALLER'S TOTAL, not the unread rows in a page
 *   - paging cannot change that total, drop a row, or repeat one
 *   - reading is scoped to the caller, in both directions: you cannot see or
 *     mutate another account's notification, and marking all read cannot reach
 *     past your own rows
 *   - marking read is idempotent
 *   - no read route generates a notification
 *
 * Phase 2B1 generation semantics are NOT exercised here and NOT changed. Rows
 * are inserted directly so the assertions are about the read surface alone;
 * `phase2b1-canonical-notifications.test.ts` remains the authority on which
 * notifications come into existence and when.
 *
 * REAL: PostgreSQL and the full Express routing stack. No Stripe, no email, no
 * outbound network of any kind.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db, pool } from "@workspace/db";
import { notifications } from "@workspace/db";
import { eq } from "drizzle-orm";

import app from "../app.js";
import { purgeSyntheticAccounts } from "../lib/owner-reset.js";

const BASE = "/api";

/**
 * One tag fixed before any fixture exists, exactly as the 2B1 suite does.
 * Teardown re-derives its fixtures by querying for this tag rather than trusting
 * values a setup helper returned, so a helper that throws half-way through still
 * leaves rows that cleanup can find.
 */
const FIXTURE_TAG = `n2b2${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const TAGGED_EMAIL_LIKE = `%-${FIXTURE_TAG}@test.invalid`;

let uniqCounter = 0;
const uniq = () => `${++uniqCounter}`;
const taggedEmail = (suffix: string) => `n2b2-${suffix}${uniq()}-${FIXTURE_TAG}@test.invalid`;

/** The owner QA account. Its emptiness is an invariant this file must preserve. */
const OWNER_EMAIL = "jordan@dripjar.dev";

interface Account {
  token: string;
  userId: string;
  auth: { Authorization: string };
}

async function register(suffix: string): Promise<Account> {
  const res = await request(app).post(`${BASE}/auth/register`).send({
    email: taggedEmail(suffix),
    password: "P@ssword1!",
    firstName: "Notif",
    lastName: suffix.replace(/[^a-zA-Z]/g, "") || "User",
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const token = res.body.token as string;
  return { token, userId: res.body.user.id as string, auth: { Authorization: `Bearer ${token}` } };
}

/**
 * Insert notifications for a user, oldest first.
 *
 * `created_at` is set explicitly and strictly increasing so "newest first" is a
 * checkable claim rather than an artefact of insert timing.
 */
async function seedNotifications(
  userId: string,
  count: number,
  opts: { isRead?: boolean; titlePrefix?: string } = {},
): Promise<string[]> {
  const base = Date.UTC(2026, 0, 1, 0, 0, 0);
  const rows = Array.from({ length: count }, (_, i) => ({
    userId,
    type: "general" as const,
    title: `${opts.titlePrefix ?? FIXTURE_TAG} #${i}`,
    message: `Seeded row ${i} for ${FIXTURE_TAG}`,
    isRead: opts.isRead ?? false,
    createdAt: new Date(base + i * 1000),
  }));
  const inserted = await db.insert(notifications).values(rows).returning({ id: notifications.id });
  return inserted.map((r) => r.id);
}

const countAllNotifications = async () =>
  Number((await pool.query(`select count(*)::int c from notifications`)).rows[0].c);

const unreadCountFor = async (userId: string) =>
  Number(
    (
      await pool.query(
        `select count(*)::int c from notifications where user_id = $1 and is_read = false`,
        [userId],
      )
    ).rows[0].c,
  );

let alice: Account;
let bob: Account;

beforeAll(async () => {
  alice = await register("alice");
  bob = await register("bob");
});

afterAll(async () => {
  const tagged = (
    await pool.query(`select email from users where email like $1 order by email`, [
      TAGGED_EMAIL_LIKE,
    ])
  ).rows.map((r) => r.email as string);

  if (tagged.length) {
    await purgeSyntheticAccounts(tagged, { approvedEmails: tagged, quiet: true });
  }

  expect(
    Number(
      (await pool.query(`select count(*)::int c from users where email like $1`, [TAGGED_EMAIL_LIKE]))
        .rows[0].c,
    ),
    "tagged users survived the purge",
  ).toBe(0);

  // Notifications are ON DELETE CASCADE from users, so removing the accounts
  // removes their rows. Assert it rather than assume it.
  expect(
    Number(
      (
        await pool.query(
          `select count(*)::int c from notifications n
             left join users u on u.id = n.user_id where u.id is null`,
        )
      ).rows[0].c,
    ),
    "orphaned notifications left behind",
  ).toBe(0);
});

// ─── Unread total ────────────────────────────────────────────────────────────

describe("exact unread count", () => {
  it("is zero, and the badge therefore hidden, for an account with no notifications", async () => {
    const fresh = await register("empty");

    const res = await request(app).get(`${BASE}/notifications/unread-count`).set(fresh.auth);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ unreadCount: 0 });

    const list = await request(app).get(`${BASE}/notifications`).set(fresh.auth);
    expect(list.status).toBe(200);
    expect(list.body).toEqual([]);
  });

  it("counts every unread row, not just the ones on the first page", async () => {
    const user = await register("deep");
    // Deliberately more than one page (25) and more than the badge cap (99).
    await seedNotifications(user.userId, 105);

    const count = await request(app).get(`${BASE}/notifications/unread-count`).set(user.auth);
    expect(count.body.unreadCount).toBe(105);

    // The behaviour the old badge had: the length of a page. It is smaller than
    // the truth, which is the entire point of the separate endpoint.
    const firstPage = await request(app)
      .get(`${BASE}/notifications?limit=25&offset=0`)
      .set(user.auth);
    expect(firstPage.body).toHaveLength(25);
    expect(firstPage.body.filter((n: { isRead: boolean }) => !n.isRead)).toHaveLength(25);
    expect(count.body.unreadCount).toBeGreaterThan(firstPage.body.length);
  });

  it("excludes rows that are already read", async () => {
    const user = await register("mixed");
    await seedNotifications(user.userId, 4, { isRead: true });
    await seedNotifications(user.userId, 3, { isRead: false });

    const res = await request(app).get(`${BASE}/notifications/unread-count`).set(user.auth);
    expect(res.body.unreadCount).toBe(3);
  });

  it("counts only the caller's rows", async () => {
    const [aBefore, bBefore] = [
      (await request(app).get(`${BASE}/notifications/unread-count`).set(alice.auth)).body.unreadCount,
      (await request(app).get(`${BASE}/notifications/unread-count`).set(bob.auth)).body.unreadCount,
    ];

    await seedNotifications(bob.userId, 6);

    const aAfter = (await request(app).get(`${BASE}/notifications/unread-count`).set(alice.auth)).body
      .unreadCount;
    const bAfter = (await request(app).get(`${BASE}/notifications/unread-count`).set(bob.auth)).body
      .unreadCount;

    expect(aAfter).toBe(aBefore);
    expect(bAfter).toBe(bBefore + 6);
  });

  it("agrees with the dashboard's unread figure", async () => {
    const user = await register("dash");
    await seedNotifications(user.userId, 7);
    await seedNotifications(user.userId, 2, { isRead: true });

    const endpoint = await request(app).get(`${BASE}/notifications/unread-count`).set(user.auth);
    const dashboard = await request(app).get(`${BASE}/dashboard`).set(user.auth);

    expect(dashboard.status).toBe(200);
    expect(endpoint.body.unreadCount).toBe(7);
    expect(dashboard.body.unreadNotifications).toBe(endpoint.body.unreadCount);
  });

  it("requires authentication", async () => {
    const res = await request(app).get(`${BASE}/notifications/unread-count`);
    expect(res.status).toBe(401);
  });
});

// ─── Pagination and ordering ─────────────────────────────────────────────────

describe("pagination", () => {
  it("walks every row exactly once and never changes the unread total", async () => {
    const user = await register("page");
    const seeded = await seedNotifications(user.userId, 60);

    const before = (await request(app).get(`${BASE}/notifications/unread-count`).set(user.auth)).body
      .unreadCount;

    const seen: string[] = [];
    for (let offset = 0; offset < 100; offset += 25) {
      const page = await request(app)
        .get(`${BASE}/notifications?limit=25&offset=${offset}`)
        .set(user.auth);
      expect(page.status).toBe(200);
      seen.push(...page.body.map((n: { id: string }) => n.id));
      if (page.body.length < 25) break;
    }

    expect(seen).toHaveLength(seeded.length);
    expect(new Set(seen).size, "a row appeared on two pages").toBe(seeded.length);
    expect([...seen].sort()).toEqual([...seeded].sort());

    const after = (await request(app).get(`${BASE}/notifications/unread-count`).set(user.auth)).body
      .unreadCount;
    expect(after).toBe(before);
  });

  it("returns newest first", async () => {
    const user = await register("order");
    await seedNotifications(user.userId, 10);

    const page = await request(app).get(`${BASE}/notifications?limit=10`).set(user.auth);
    const timestamps = page.body.map((n: { createdAt: string }) => new Date(n.createdAt).getTime());
    const descending = [...timestamps].sort((a, b) => b - a);
    expect(timestamps).toEqual(descending);
    // Seeded oldest-first, so the last seeded row is the first returned.
    expect(page.body[0].title).toContain("#9");
  });

  it("orders deterministically when timestamps tie", async () => {
    const user = await register("tie");
    const at = new Date(Date.UTC(2026, 0, 2, 3, 4, 5));
    await db.insert(notifications).values(
      Array.from({ length: 12 }, (_, i) => ({
        userId: user.userId,
        type: "general" as const,
        title: `tie ${i}`,
        message: "same instant",
        isRead: false,
        createdAt: at,
      })),
    );

    const first = await request(app).get(`${BASE}/notifications?limit=12`).set(user.auth);
    const second = await request(app).get(`${BASE}/notifications?limit=12`).set(user.auth);
    expect(first.body.map((n: { id: string }) => n.id)).toEqual(
      second.body.map((n: { id: string }) => n.id),
    );

    // And the two halves of a paged walk do not overlap.
    const a = await request(app).get(`${BASE}/notifications?limit=6&offset=0`).set(user.auth);
    const b = await request(app).get(`${BASE}/notifications?limit=6&offset=6`).set(user.auth);
    const ids = [...a.body, ...b.body].map((n: { id: string }) => n.id);
    expect(new Set(ids).size).toBe(12);
  });

  it("caps an oversized limit rather than honouring it", async () => {
    const user = await register("cap");
    await seedNotifications(user.userId, 120);

    const res = await request(app).get(`${BASE}/notifications?limit=5000`).set(user.auth);
    expect(res.body.length).toBeLessThanOrEqual(100);
    expect(res.body).toHaveLength(100);
  });

  it("defaults to the historical page size when no limit is given", async () => {
    const user = await register("default");
    await seedNotifications(user.userId, 60);

    const res = await request(app).get(`${BASE}/notifications`).set(user.auth);
    expect(res.body).toHaveLength(50);
  });

  it("ignores a nonsense limit or offset instead of failing", async () => {
    const user = await register("junk");
    await seedNotifications(user.userId, 5);

    const res = await request(app)
      .get(`${BASE}/notifications?limit=abc&offset=-40`)
      .set(user.auth);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(5);
  });

  it("still honours unreadOnly", async () => {
    const user = await register("unreadonly");
    await seedNotifications(user.userId, 4, { isRead: true });
    await seedNotifications(user.userId, 2, { isRead: false });

    const res = await request(app).get(`${BASE}/notifications?unreadOnly=true`).set(user.auth);
    expect(res.body).toHaveLength(2);
    expect(res.body.every((n: { isRead: boolean }) => !n.isRead)).toBe(true);
  });
});

// ─── Mark one read ───────────────────────────────────────────────────────────

describe("mark one notification read", () => {
  it("affects exactly one row and decrements the total by exactly one", async () => {
    const user = await register("one");
    const ids = await seedNotifications(user.userId, 5);
    const target = ids[2]!;

    const before = await unreadCountFor(user.userId);
    const res = await request(app).patch(`${BASE}/notifications/${target}/read`).set(user.auth);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(target);
    expect(res.body.isRead).toBe(true);
    expect(await unreadCountFor(user.userId)).toBe(before - 1);

    const rows = await db.select().from(notifications).where(eq(notifications.userId, user.userId));
    expect(rows.filter((r) => r.isRead).map((r) => r.id)).toEqual([target]);
  });

  it("is idempotent — repeating it changes nothing", async () => {
    const user = await register("idem");
    const [target] = await seedNotifications(user.userId, 3);

    const first = await request(app).patch(`${BASE}/notifications/${target}/read`).set(user.auth);
    const afterFirst = await unreadCountFor(user.userId);

    const second = await request(app).patch(`${BASE}/notifications/${target}/read`).set(user.auth);
    const third = await request(app).patch(`${BASE}/notifications/${target}/read`).set(user.auth);

    expect(second.status).toBe(200);
    expect(third.status).toBe(200);
    expect(second.body.id).toBe(first.body.id);
    expect(third.body.isRead).toBe(true);
    expect(await unreadCountFor(user.userId)).toBe(afterFirst);
  });

  it("resolves the jar name rather than returning null for it", async () => {
    const user = await register("jarname");
    const create = await request(app)
      .post(`${BASE}/jars`)
      .set(user.auth)
      .send({
        name: `Jar ${FIXTURE_TAG} ${uniq()}`,
        category: "Vacation",
        goalAmountCents: 500_000,
        targetDate: new Date(Date.now() + 120 * 86_400_000).toISOString().slice(0, 10),
      });
    expect(create.status, JSON.stringify(create.body)).toBe(201);
    const jarId = create.body.id as string;

    const [row] = await db
      .insert(notifications)
      .values({
        userId: user.userId,
        type: "general",
        title: "Jar linked",
        message: "Has a jar",
        relatedJarId: jarId,
        isRead: false,
      })
      .returning({ id: notifications.id });

    const list = await request(app).get(`${BASE}/notifications`).set(user.auth);
    const listed = list.body.find((n: { id: string }) => n.id === row!.id);
    expect(listed.relatedJarName).toBe(create.body.name);

    const patched = await request(app).patch(`${BASE}/notifications/${row!.id}/read`).set(user.auth);
    // Previously hard-coded null here, so the name vanished the moment a row
    // was tapped.
    expect(patched.body.relatedJarName).toBe(create.body.name);
  });
});

// ─── Mark all read ───────────────────────────────────────────────────────────

describe("mark all notifications read", () => {
  it("clears the caller's unread rows and leaves every other account untouched", async () => {
    const mine = await register("all-mine");
    const theirs = await register("all-theirs");
    await seedNotifications(mine.userId, 8);
    await seedNotifications(theirs.userId, 5);

    const theirsBefore = await unreadCountFor(theirs.userId);

    const res = await request(app).post(`${BASE}/notifications/read-all`).set(mine.auth);
    expect(res.status).toBe(200);

    expect(await unreadCountFor(mine.userId)).toBe(0);
    expect(await unreadCountFor(theirs.userId)).toBe(theirsBefore);

    const count = await request(app).get(`${BASE}/notifications/unread-count`).set(mine.auth);
    expect(count.body.unreadCount).toBe(0);
  });

  it("is idempotent", async () => {
    const user = await register("all-idem");
    await seedNotifications(user.userId, 4);

    await request(app).post(`${BASE}/notifications/read-all`).set(user.auth);
    const second = await request(app).post(`${BASE}/notifications/read-all`).set(user.auth);

    expect(second.status).toBe(200);
    expect(await unreadCountFor(user.userId)).toBe(0);
  });

  it("clears unread rows beyond the first page", async () => {
    const user = await register("all-deep");
    await seedNotifications(user.userId, 130);

    await request(app).post(`${BASE}/notifications/read-all`).set(user.auth);

    expect(await unreadCountFor(user.userId)).toBe(0);
  });
});

// ─── Caller scoping ──────────────────────────────────────────────────────────

describe("caller scoping", () => {
  it("never lists another account's notifications", async () => {
    const victim = await register("victim");
    const attacker = await register("attacker");
    const victimIds = await seedNotifications(victim.userId, 5);

    const res = await request(app).get(`${BASE}/notifications?limit=100`).set(attacker.auth);
    const returnedIds = res.body.map((n: { id: string }) => n.id);
    for (const id of victimIds) expect(returnedIds).not.toContain(id);
    expect(res.body.every((n: { userId: string }) => n.userId === attacker.userId)).toBe(true);
  });

  it("refuses to mark another account's notification read, and does not mutate it", async () => {
    const victim = await register("victim2");
    const attacker = await register("attacker2");
    const [victimNotification] = await seedNotifications(victim.userId, 1);

    const res = await request(app)
      .patch(`${BASE}/notifications/${victimNotification}/read`)
      .set(attacker.auth);

    expect(res.status).toBe(404);
    const [row] = await db
      .select()
      .from(notifications)
      .where(eq(notifications.id, victimNotification!));
    expect(row!.isRead, "another account's notification was mutated").toBe(false);
  });

  it("answers a foreign id exactly as it answers a nonexistent one", async () => {
    const victim = await register("victim3");
    const attacker = await register("attacker3");
    const [victimNotification] = await seedNotifications(victim.userId, 1);

    const foreign = await request(app)
      .patch(`${BASE}/notifications/${victimNotification}/read`)
      .set(attacker.auth);
    const absent = await request(app)
      .patch(`${BASE}/notifications/00000000-0000-4000-8000-000000000000/read`)
      .set(attacker.auth);

    // Identical responses, so the endpoint cannot be used to test whether an id
    // exists on another account.
    expect(foreign.status).toBe(absent.status);
    expect(foreign.body).toEqual(absent.body);
  });

  it("answers a malformed id with 404 rather than a 500", async () => {
    const user = await register("malformed");

    const res = await request(app).patch(`${BASE}/notifications/not-a-uuid/read`).set(user.auth);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("NotFound");
  });

  it("requires authentication on every route", async () => {
    const [list, count, one, all] = await Promise.all([
      request(app).get(`${BASE}/notifications`),
      request(app).get(`${BASE}/notifications/unread-count`),
      request(app).patch(`${BASE}/notifications/00000000-0000-4000-8000-000000000000/read`),
      request(app).post(`${BASE}/notifications/read-all`),
    ]);
    expect([list.status, count.status, one.status, all.status]).toEqual([401, 401, 401, 401]);
  });
});

// ─── Reads do not generate ───────────────────────────────────────────────────

describe("reading never creates a notification", () => {
  it("holds across the list, the count, mark-read, mark-all-read, and the dashboard", async () => {
    const user = await register("noside");
    const ids = await seedNotifications(user.userId, 3);

    const totalBefore = await countAllNotifications();

    await request(app).get(`${BASE}/notifications`).set(user.auth).expect(200);
    await request(app).get(`${BASE}/notifications?unreadOnly=true`).set(user.auth).expect(200);
    await request(app).get(`${BASE}/notifications/unread-count`).set(user.auth).expect(200);
    await request(app).get(`${BASE}/dashboard`).set(user.auth).expect(200);
    await request(app).patch(`${BASE}/notifications/${ids[0]}/read`).set(user.auth).expect(200);
    await request(app).post(`${BASE}/notifications/read-all`).set(user.auth).expect(200);
    await request(app).get(`${BASE}/notifications`).set(user.auth).expect(200);

    expect(await countAllNotifications()).toBe(totalBefore);
  });

  it("does not create a notification for a listing account with none", async () => {
    const fresh = await register("noside-empty");

    await request(app).get(`${BASE}/notifications`).set(fresh.auth).expect(200);
    await request(app).get(`${BASE}/notifications/unread-count`).set(fresh.auth).expect(200);
    await request(app).post(`${BASE}/notifications/read-all`).set(fresh.auth).expect(200);

    const rows = await db.select().from(notifications).where(eq(notifications.userId, fresh.userId));
    expect(rows).toHaveLength(0);
  });
});

// ─── Owner QA account ────────────────────────────────────────────────────────

describe("owner QA account", () => {
  it("still has zero notifications after this suite has run", async () => {
    const [owner] = (
      await pool.query(`select id from users where email = $1`, [OWNER_EMAIL])
    ).rows;
    // The account is expected to exist in the validation database; if a run
    // happens without it, there is nothing to protect and nothing to assert.
    if (!owner) return;

    expect(await unreadCountFor(owner.id), "owner picked up notifications").toBe(0);
    expect(
      Number(
        (
          await pool.query(`select count(*)::int c from notifications where user_id = $1`, [owner.id])
        ).rows[0].c,
      ),
    ).toBe(0);
  });
});
