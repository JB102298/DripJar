/**
 * Caller-scoped history — Owner QA item 11.
 *
 * THE BUG. The Profile screen's "Contributed" stat rendered
 * `dashboard.personalProgress.contributedAmountCents`: the caller's saved
 * principal in the *featured* jar, i.e. whichever jar was updated most
 * recently. Next to a "Jars" count spanning every jar, on a profile page, it
 * read as a lifetime total — and moved when an unrelated jar changed.
 *
 * WHAT THESE TESTS PIN.
 *
 * 1. Reconciliation. The Profile stat, the per-jar rows, and the contribution
 *    list must be the same number at three granularities. They are derived from
 *    one set of ledger credits precisely so they cannot disagree, and these
 *    tests are what prove the identity rather than assuming it — the same
 *    stance canonical-saved-principal.test.ts takes for milestone attribution.
 *
 * 2. "Lifetime" means lifetime. Refunding principal moves it between accounts;
 *    it does not un-contribute it. Committing principal likewise. Neither may
 *    reduce the lifetime figure, and both must move the *currently saved*
 *    figure — which is why the two are reported separately rather than one
 *    number labelled ambiguously.
 *
 * 3. Test Mode money never counts. `contributions.status = 'simulated'` rows
 *    have no ledger backing by design; they were the source of the original
 *    $7,274-vs-$0 split between Home and Jar Overview.
 *
 * 4. Privacy. Caller-scoped only, and no internal identifier leaves the server
 *    beyond the jar id the client needs in order to navigate.
 */
import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { db, jarMembers, contributions } from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import app from "../app.js";
import {
  postContributionAccounting,
  postCommitPrincipal,
  postRefundPrincipal,
  clearLedgerAccountCache,
} from "../lib/ledger.js";

const unique = () => `me-${Date.now()}-${Math.random().toString(36).slice(2)}`;

interface TestUser {
  token: string;
  userId: string;
}

async function registerUser(): Promise<TestUser> {
  const res = await request(app).post("/api/auth/register").send({
    email: `${unique()}@example.com`,
    password: "password123",
    firstName: "Me",
    lastName: "History",
  });
  expect(res.status).toBe(201);
  return { token: res.body.token as string, userId: res.body.user.id as string };
}

async function createJar(token: string, name: string, category: string): Promise<string> {
  const res = await request(app)
    .post("/api/jars")
    .set("Authorization", `Bearer ${token}`)
    .send({
      name: `${name} ${unique()}`,
      category,
      goalAmountCents: 1_000_000,
      targetDate: new Date(Date.now() + 365 * 86_400_000).toISOString().slice(0, 10),
    });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

async function memberIdFor(jarId: string, userId: string): Promise<string> {
  const [row] = await db
    .select({ id: jarMembers.id })
    .from(jarMembers)
    .where(and(eq(jarMembers.jarId, jarId), eq(jarMembers.userId, userId)));
  expect(row, "membership row missing").toBeDefined();
  return row!.id;
}

async function contribute(jarId: string, memberId: string, principalCents: number) {
  clearLedgerAccountCache();
  await postContributionAccounting({ jarId, memberId, principalCents });
}

// ─── Fixture ─────────────────────────────────────────────────────────────────
//
// Jar A: 50 000 + 25 000 contributed, 20 000 committed, 5 000 refunded.
//        lifetime 75 000 · currently saved 70 000 · refunded 5 000
// Jar B: 10 000 contributed.
//        lifetime 10 000 · currently saved 10 000
// Plus a Test Mode row on Jar A which must be invisible to every figure.

const A_CONTRIB_1 = 50_000;
const A_CONTRIB_2 = 25_000;
const A_COMMITTED = 20_000;
const A_REFUNDED = 5_000;
const B_CONTRIB = 10_000;

const EXPECTED_LIFETIME = A_CONTRIB_1 + A_CONTRIB_2 + B_CONTRIB;
const EXPECTED_SAVED = A_CONTRIB_1 + A_CONTRIB_2 - A_REFUNDED + B_CONTRIB;
const EXPECTED_CONTRIBUTION_COUNT = 3;

let user: TestUser;
let stranger: TestUser;
let jarA: string;
let jarB: string;

beforeAll(async () => {
  clearLedgerAccountCache();

  user = await registerUser();
  stranger = await registerUser();

  jarA = await createJar(user.token, "History A", "Vacation");
  jarB = await createJar(user.token, "History B", "EmergencyFund");

  const memberA = await memberIdFor(jarA, user.userId);
  const memberB = await memberIdFor(jarB, user.userId);

  await contribute(jarA, memberA, A_CONTRIB_1);
  await contribute(jarA, memberA, A_CONTRIB_2);
  await contribute(jarB, memberB, B_CONTRIB);

  await postCommitPrincipal({ jarId: jarA, memberId: memberA, principalCents: A_COMMITTED });
  await postRefundPrincipal({ jarId: jarA, memberId: memberA, principalCents: A_REFUNDED });

  // Test Mode: a display row with no ledger backing. Must change nothing.
  await db.insert(contributions).values({
    jarId: jarA,
    memberId: memberA,
    amountCents: 999_999,
    contributionDate: "2026-01-01",
    status: "simulated",
    sourceType: "manual",
  });

  // The stranger contributes to their own jar, so a scoping failure would show.
  const strangerJar = await createJar(stranger.token, "Stranger", "Wedding");
  const strangerMember = await memberIdFor(strangerJar, stranger.userId);
  await contribute(strangerJar, strangerMember, 777_000);
});

async function getMyJars(token: string) {
  const res = await request(app).get("/api/me/jars").set("Authorization", `Bearer ${token}`);
  expect(res.status).toBe(200);
  return res.body as {
    summary: Record<string, number | boolean>;
    jars: Array<Record<string, unknown>>;
  };
}

interface ContributionsResponse {
  summary: Record<string, number | boolean>;
  contributions: Array<Record<string, unknown>>;
  pageInfo: {
    hasMore: boolean;
    nextCursor: string | null;
    limit: number;
    totalCount: number;
  };
}

async function getMyContributions(token: string, query = ""): Promise<ContributionsResponse> {
  const res = await request(app)
    .get(`/api/me/contributions${query}`)
    .set("Authorization", `Bearer ${token}`);
  expect(res.status).toBe(200);
  return res.body as ContributionsResponse;
}

/**
 * Walk the whole cursor chain.
 *
 * Returns every row plus the number of requests it took, so tests can assert
 * that pagination actually happened rather than that one oversized page was
 * returned.
 */
async function drainContributions(
  token: string,
  limit: number,
): Promise<{ rows: Array<Record<string, unknown>>; pages: number; summary: Record<string, number | boolean> }> {
  const rows: Array<Record<string, unknown>> = [];
  let cursor: string | null = null;
  let pages = 0;
  let summary: Record<string, number | boolean> = {};

  // Bounded so a cursor bug cannot spin forever inside the test runner.
  for (let guard = 0; guard < 200; guard++) {
    const query = `?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const page: ContributionsResponse = await getMyContributions(token, query);
    pages += 1;
    summary = page.summary;
    rows.push(...page.contributions);
    if (!page.pageInfo.hasMore) {
      expect(page.pageInfo.nextCursor).toBeNull();
      return { rows, pages, summary };
    }
    expect(page.pageInfo.nextCursor).toBeTruthy();
    cursor = page.pageInfo.nextCursor;
  }
  throw new Error("cursor chain did not terminate");
}

// ─── Authentication ──────────────────────────────────────────────────────────

describe("authentication", () => {
  it("rejects an unauthenticated /me/jars", async () => {
    const res = await request(app).get("/api/me/jars");
    expect(res.status).toBe(401);
  });

  it("rejects an unauthenticated /me/contributions", async () => {
    const res = await request(app).get("/api/me/contributions");
    expect(res.status).toBe(401);
  });
});

// ─── Reconciliation ──────────────────────────────────────────────────────────

describe("summary and drill-down reconcile exactly", () => {
  it("reports the expected lifetime total", async () => {
    const { summary } = await getMyJars(user.token);
    expect(summary.lifetimeContributedPrincipalCents).toBe(EXPECTED_LIFETIME);
  });

  it("sums the per-jar rows to the summary", async () => {
    const { summary, jars } = await getMyJars(user.token);
    const rowSum = jars.reduce(
      (sum, j) => sum + (j.lifetimeContributedPrincipalCents as number),
      0,
    );
    expect(rowSum).toBe(summary.lifetimeContributedPrincipalCents);
  });

  it("sums the contribution rows to the same total", async () => {
    const { summary, contributions: rows, pageInfo } = await getMyContributions(user.token);
    expect(pageInfo.hasMore).toBe(false);
    const rowSum = rows.reduce((sum, c) => sum + (c.principalCents as number), 0);
    expect(rowSum).toBe(summary.lifetimeContributedPrincipalCents);
  });

  it("returns the same summary object from both endpoints", async () => {
    const jarsRes = await getMyJars(user.token);
    const contribRes = await getMyContributions(user.token);
    expect(contribRes.summary).toEqual(jarsRes.summary);
  });

  it("counts every contribution event once", async () => {
    const { summary, contributions: rows } = await getMyContributions(user.token);
    expect(summary.contributionCount).toBe(EXPECTED_CONTRIBUTION_COUNT);
    expect(rows).toHaveLength(EXPECTED_CONTRIBUTION_COUNT);
  });

  it("reports every jar as reconciled", async () => {
    const { summary, jars } = await getMyJars(user.token);
    expect(summary.reconciles).toBe(true);
    for (const jar of jars) {
      expect(jar.reconciles, `jar ${jar.name} did not reconcile`).toBe(true);
    }
  });
});

// ─── Lifetime vs currently saved ─────────────────────────────────────────────

describe("lifetime is not the same as currently saved", () => {
  it("does not reduce the lifetime figure when principal is refunded", async () => {
    const { summary } = await getMyJars(user.token);
    // 5 000 was refunded out of jar A and is still counted as contributed.
    expect(summary.lifetimeContributedPrincipalCents).toBe(EXPECTED_LIFETIME);
    expect(summary.refundedPrincipalCents).toBe(A_REFUNDED);
  });

  it("does reduce the currently-saved figure when principal is refunded", async () => {
    const { summary } = await getMyJars(user.token);
    expect(summary.currentlySavedPrincipalCents).toBe(EXPECTED_SAVED);
    expect(summary.currentlySavedPrincipalCents).toBeLessThan(
      summary.lifetimeContributedPrincipalCents as number,
    );
  });

  it("does not reduce either figure when principal is committed", async () => {
    // Committing moves refundable → committed. Both still count as saved.
    const { jars } = await getMyJars(user.token);
    const a = jars.find((j) => (j.jarId as string) === jarA)!;
    expect(a.lifetimeContributedPrincipalCents).toBe(A_CONTRIB_1 + A_CONTRIB_2);
    expect(a.currentlySavedPrincipalCents).toBe(A_CONTRIB_1 + A_CONTRIB_2 - A_REFUNDED);
  });

  it("keeps a jar with no refunds identical on both figures", async () => {
    const { jars } = await getMyJars(user.token);
    const b = jars.find((j) => (j.jarId as string) === jarB)!;
    expect(b.lifetimeContributedPrincipalCents).toBe(B_CONTRIB);
    expect(b.currentlySavedPrincipalCents).toBe(B_CONTRIB);
  });
});

// ─── Test Mode exclusion ─────────────────────────────────────────────────────

describe("Test Mode money is never counted", () => {
  it("ignores simulated contributions entirely", async () => {
    // A 999 999¢ simulated row sits on jar A. If contribution status were ever
    // treated as evidence of money, it would dominate every figure here.
    const { summary } = await getMyJars(user.token);
    expect(summary.lifetimeContributedPrincipalCents).toBe(EXPECTED_LIFETIME);
    expect(summary.currentlySavedPrincipalCents).toBe(EXPECTED_SAVED);
  });

  it("lists no simulated row in the contribution history", async () => {
    const { contributions: rows } = await getMyContributions(user.token);
    expect(rows.some((c) => (c.principalCents as number) === 999_999)).toBe(false);
  });
});

// ─── Privacy and scoping ─────────────────────────────────────────────────────

describe("caller scoping", () => {
  it("shows a user only their own jars", async () => {
    const { jars } = await getMyJars(user.token);
    const ids = jars.map((j) => j.jarId as string).sort();
    expect(ids).toEqual([jarA, jarB].sort());
  });

  it("shows another user none of this user's money", async () => {
    const { summary, jars } = await getMyJars(stranger.token);
    expect(summary.lifetimeContributedPrincipalCents).toBe(777_000);
    for (const jar of jars) {
      expect([jarA, jarB]).not.toContain(jar.jarId as string);
    }
  });

  it("shows another user none of this user's contributions", async () => {
    const { contributions: rows } = await getMyContributions(stranger.token);
    for (const row of rows) {
      expect([jarA, jarB]).not.toContain(row.jarId as string);
    }
  });
});

describe("no internal identifiers leave the server", () => {
  const INTERNAL_ID_KEYS = [
    "memberId",
    "userId",
    "financialTransactionId",
    "ledgerTransactionId",
    "ledgerId",
    "accountId",
    "id",
  ];

  it("exposes only jarId on a contribution row", async () => {
    const { contributions: rows } = await getMyContributions(user.token);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      for (const key of INTERNAL_ID_KEYS) {
        expect(Object.keys(row), `contribution row leaks ${key}`).not.toContain(key);
      }
      expect(Object.keys(row)).toContain("jarId");
    }
  });

  it("exposes no member id on a jar row", async () => {
    const { jars } = await getMyJars(user.token);
    for (const jar of jars) {
      expect(Object.keys(jar)).not.toContain("memberId");
      expect(Object.keys(jar)).not.toContain("userId");
    }
  });
});

// ─── Row shape and limits ────────────────────────────────────────────────────

describe("contribution rows", () => {
  it("carries the jar name so the list is readable without a second request", async () => {
    const { contributions: rows } = await getMyContributions(user.token);
    for (const row of rows) {
      expect(typeof row.jarName).toBe("string");
      expect((row.jarName as string).length).toBeGreaterThan(0);
      expect(typeof row.occurredAt).toBe("string");
      expect(row.currency).toBe("USD");
    }
  });

  it("returns newest first", async () => {
    const { contributions: rows } = await getMyContributions(user.token);
    const times = rows.map((c) => new Date(c.occurredAt as string).getTime());
    for (let i = 1; i < times.length; i++) {
      expect(times[i - 1]!).toBeGreaterThanOrEqual(times[i]!);
    }
  });

  it("offers a next cursor rather than silently dropping rows", async () => {
    const res = await getMyContributions(user.token, "?limit=1");
    expect(res.pageInfo.limit).toBe(1);
    expect(res.contributions).toHaveLength(1);
    expect(res.pageInfo.hasMore).toBe(true);
    expect(res.pageInfo.nextCursor).toBeTruthy();
    // The summary still covers everything, which is why the page count is
    // reported separately rather than inferred from the rows.
    expect(res.summary.lifetimeContributedPrincipalCents).toBe(EXPECTED_LIFETIME);
    expect(res.pageInfo.totalCount).toBe(EXPECTED_CONTRIBUTION_COUNT);
  });

  it("clamps an absurd limit rather than trusting it", async () => {
    const res = await getMyContributions(user.token, "?limit=99999");
    expect(res.pageInfo.limit).toBe(200);
  });

  it("falls back to the default for nonsense input", async () => {
    const res = await getMyContributions(user.token, "?limit=banana");
    expect(res.pageInfo.limit).toBe(50);
  });

  it("rejects a malformed cursor instead of restarting from the top", async () => {
    // Silently restarting would send a reader who is fifteen pages in back to
    // page one and duplicate everything already loaded — a wrong answer
    // wearing a 200.
    const res = await request(app)
      .get("/api/me/contributions?cursor=not-a-real-cursor")
      .set("Authorization", `Bearer ${user.token}`);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/cursor/i);
  });

  it("rejects a well-formed cursor whose id half is not a uuid", async () => {
    const forged = Buffer.from(`${new Date().toISOString()}|nonsense`, "utf8").toString("base64url");
    const res = await request(app)
      .get(`/api/me/contributions?cursor=${forged}`)
      .set("Authorization", `Bearer ${user.token}`);
    expect(res.status).toBe(400);
  });
});

describe("jar rows", () => {
  it("carries what the history screen needs to label a jar", async () => {
    const { jars } = await getMyJars(user.token);
    for (const jar of jars) {
      expect(typeof jar.name).toBe("string");
      expect(typeof jar.status).toBe("string");
      expect(typeof jar.role).toBe("string");
      expect(typeof jar.membershipStatus).toBe("string");
      expect(typeof jar.targetDate).toBe("string");
      expect(typeof jar.goalAmountCents).toBe("number");
    }
  });

  it("returns an empty history rather than an error for a brand-new user", async () => {
    const fresh = await registerUser();
    const { summary, jars } = await getMyJars(fresh.token);
    expect(jars).toEqual([]);
    expect(summary.lifetimeContributedPrincipalCents).toBe(0);
    expect(summary.jarCount).toBe(0);
    expect(summary.reconciles).toBe(true);

    const contribRes = await getMyContributions(fresh.token);
    expect(contribRes.contributions).toEqual([]);
    expect(contribRes.pageInfo.hasMore).toBe(false);
    expect(contribRes.pageInfo.nextCursor).toBeNull();
  });
});

// ─── Pagination at real volume ───────────────────────────────────────────────
//
// The endpoint previously capped at 500 rows. A weekly AutoDrip produces ~52
// rows a year per member and this product supports eighteen-year goals, so the
// cap was a point at which the app would quietly stop showing a member their
// own money. These tests run past that old boundary deliberately.

describe("pagination over more than 500 contributions", () => {
  const VOLUME = 520;
  /**
   * Every contribution gets a DISTINCT amount (1000, 1001, … 1519).
   *
   * That is what makes duplicate-and-skip detection real: with identical
   * amounts, a page that repeated rows and a page that returned the right ones
   * would look the same. Distinct amounts turn "no duplicates" into a set
   * comparison rather than a count.
   */
  const amountFor = (i: number) => 1_000 + i;
  const EXPECTED_VOLUME_TOTAL = Array.from({ length: VOLUME }, (_, i) => amountFor(i)).reduce(
    (a, b) => a + b,
    0,
  );

  let heavy: TestUser;
  let heavyJar: string;

  beforeAll(async () => {
    heavy = await registerUser();
    heavyJar = await createJar(heavy.token, "High Volume", "Education");
    const member = await memberIdFor(heavyJar, heavy.userId);

    clearLedgerAccountCache();
    for (let i = 0; i < VOLUME; i++) {
      await postContributionAccounting({
        jarId: heavyJar,
        memberId: member,
        principalCents: amountFor(i),
      });
    }
  }, 240_000);

  it("reports the complete lifetime total, not one page of it", async () => {
    const { summary } = await getMyContributions(heavy.token, "?limit=50");
    expect(summary.lifetimeContributedPrincipalCents).toBe(EXPECTED_VOLUME_TOTAL);
    expect(summary.contributionCount).toBe(VOLUME);
  });

  it("returns every row exactly once across the cursor chain", async () => {
    const { rows, pages, summary } = await drainContributions(heavy.token, 50);

    expect(pages).toBeGreaterThan(10);
    expect(rows).toHaveLength(VOLUME);

    // Every amount is distinct, so this proves no row was repeated and none
    // was skipped — not merely that the count happened to work out.
    const amounts = rows.map((r) => r.principalCents as number);
    expect(new Set(amounts).size).toBe(VOLUME);
    expect([...amounts].sort((a, b) => a - b)).toEqual(
      Array.from({ length: VOLUME }, (_, i) => amountFor(i)),
    );

    // Sums to the summary once the whole chain is walked — which is the
    // contract: reconciliation is against the full history, not one page.
    expect(amounts.reduce((a, b) => a + b, 0)).toBe(summary.lifetimeContributedPrincipalCents);
  }, 120_000);

  it("produces the identical row set at any page size", async () => {
    // If the boundary logic were wrong, changing the page size would move which
    // rows land on a seam and the two walks would disagree.
    const small = await drainContributions(heavy.token, 7);
    const large = await drainContributions(heavy.token, 200);

    expect(small.rows).toHaveLength(VOLUME);
    expect(large.rows).toHaveLength(VOLUME);
    expect(small.rows.map((r) => r.principalCents)).toEqual(
      large.rows.map((r) => r.principalCents),
    );
  }, 180_000);

  it("orders strictly newest-first across page boundaries", async () => {
    const { rows } = await drainContributions(heavy.token, 33);
    const times = rows.map((r) => new Date(r.occurredAt as string).getTime());
    for (let i = 1; i < times.length; i++) {
      expect(times[i - 1]!).toBeGreaterThanOrEqual(times[i]!);
    }
  }, 120_000);

  it("does not leak the high-volume user's history to anyone else", async () => {
    const { rows } = await drainContributions(user.token, 50);
    for (const row of rows) {
      expect(row.jarId).not.toBe(heavyJar);
    }
  });

  it("still exposes no internal identifier at volume", async () => {
    const { contributions: rows } = await getMyContributions(heavy.token, "?limit=200");
    for (const row of rows) {
      expect(Object.keys(row)).not.toContain("id");
      expect(Object.keys(row)).not.toContain("memberId");
    }
  });
});

// ─── The case that makes a createdAt-only cursor wrong ───────────────────────
//
// Postgres `now()` is transaction-start time, so every posting written in ONE
// transaction shares a `created_at` to the microsecond. A batch AutoDrip run is
// exactly that shape. With `created_at` as the sole sort key, the ordering
// within such a block is whatever the planner chooses and is not stable between
// queries — so the seam between two pages is undefined, and rows repeat or
// disappear depending on which plan each request happened to get.
//
// The contributions above are written one transaction each and so do NOT
// collide, which is why this fixture forces the collision rather than hoping
// for it.

describe("cursor stability when timestamps are identical", () => {
  const COLLIDING = 60;
  const amountFor = (i: number) => 500_000 + i;

  let batchUser: TestUser;
  let batchJar: string;

  beforeAll(async () => {
    batchUser = await registerUser();
    batchJar = await createJar(batchUser.token, "Batch", "EmergencyFund");
    const member = await memberIdFor(batchJar, batchUser.userId);

    clearLedgerAccountCache();
    for (let i = 0; i < COLLIDING; i++) {
      await postContributionAccounting({
        jarId: batchJar,
        memberId: member,
        principalCents: amountFor(i),
      });
    }

    // Collapse every posting onto one instant, as a single-transaction batch
    // would have produced natively.
    await db.execute(
      sql`UPDATE financial_transactions
             SET created_at = TIMESTAMP '2026-03-01 12:00:00'
           WHERE jar_id = ${batchJar}`,
    );
  }, 240_000);

  it("has genuinely identical timestamps, so the test exercises what it claims", async () => {
    const distinct = await db.execute(
      sql`SELECT count(DISTINCT created_at)::int AS n
            FROM financial_transactions WHERE jar_id = ${batchJar}`,
    );
    expect(Number((distinct.rows[0] as { n: number }).n)).toBe(1);
  });

  it("returns every row exactly once despite the collision", async () => {
    const { rows } = await drainContributions(batchUser.token, 25);

    expect(rows).toHaveLength(COLLIDING);
    const amounts = rows.map((r) => r.principalCents as number);
    expect(new Set(amounts).size).toBe(COLLIDING);
    expect([...amounts].sort((a, b) => a - b)).toEqual(
      Array.from({ length: COLLIDING }, (_, i) => amountFor(i)),
    );
  }, 120_000);

  it("keeps consecutive pages disjoint", async () => {
    const first = await getMyContributions(batchUser.token, "?limit=20");
    const second = await getMyContributions(
      batchUser.token,
      `?limit=20&cursor=${encodeURIComponent(first.pageInfo.nextCursor!)}`,
    );

    expect(first.contributions).toHaveLength(20);
    expect(second.contributions).toHaveLength(20);

    const firstAmounts = new Set(first.contributions.map((r) => r.principalCents as number));
    for (const amount of second.contributions.map((r) => r.principalCents as number)) {
      expect(firstAmounts.has(amount), `row ${amount} appeared on both pages`).toBe(false);
    }
  });

  it("is repeatable — the same page boundary twice yields the same rows", async () => {
    // A non-deterministic ordering would show up here as two different answers
    // to the same request.
    const a = await drainContributions(batchUser.token, 13);
    const b = await drainContributions(batchUser.token, 13);
    expect(a.rows.map((r) => r.principalCents)).toEqual(b.rows.map((r) => r.principalCents));
  }, 120_000);

  it("still reports the complete lifetime total", async () => {
    const { summary } = await getMyContributions(batchUser.token, "?limit=5");
    const expected = Array.from({ length: COLLIDING }, (_, i) => amountFor(i)).reduce((x, y) => x + y, 0);
    expect(summary.lifetimeContributedPrincipalCents).toBe(expected);
    expect(summary.contributionCount).toBe(COLLIDING);
  });
});
