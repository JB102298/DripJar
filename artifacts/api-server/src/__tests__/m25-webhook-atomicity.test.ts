/**
 * Phase M2.5 — Webhook Accounting Atomicity and Pool-Deadlock Regression
 *
 * Covers what `phase4b-webhook-concurrency.test.ts` cannot: that the Stripe
 * webhook handler does its financial posting inside ONE transaction on ONE pool
 * connection, that the whole posting commits or rolls back together, and that
 * the specific two-connection deadlock M2.5 removed cannot come back.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ PART I  — the mechanism, structurally                                   │
 * │   A private 2-connection pool. The old nested-transaction shape starves │
 * │   and reports a bounded connection timeout; the new single-transaction  │
 * │   shape completes. Proves the cause rather than asserting it.           │
 * ├─────────────────────────────────────────────────────────────────────────┤
 * │ PART II — ten concurrent distinct event IDs, one payment intent         │
 * │   A gate connection holds the financial-transaction row lock until all  │
 * │   ten deliveries are provably blocked on it, then releases. Proves the  │
 * │   deliveries genuinely overlap, that ten in-flight outer transactions   │
 * │   need ten connections and not twenty, and that the financial outcome   │
 * │   is exactly one contribution.                                          │
 * ├─────────────────────────────────────────────────────────────────────────┤
 * │ PART III — atomicity                                                    │
 * │   A failure injected after the accounting work but before COMMIT, and   │
 * │   an explicit rollback, each leave nothing behind. A later legitimate   │
 * │   retry then succeeds exactly once. Standalone callers still commit.    │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * ─── NO SLEEPS, NO SERIALISATION, NO RETRIES ─────────────────────────────────
 *
 * Every wait here is a condition poll against a deadline, and every deadline is
 * a failure, never a skip or a relaxation. Nothing in this file reduces worker
 * count, serialises the suite, or reruns a failed assertion. Concurrency is
 * established by a database row lock, not by hoping requests interleave.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql as drizzleSql, eq, and } from "drizzle-orm";
import type { Pool as PgPool, PoolConfig, PoolClient } from "pg";
import app from "../app.js";
import { db, pool } from "@workspace/db";
import {
  jarMembers,
  financialTransactions,
  stripeWebhookEvents,
  contributions,
  ledgerTransactions,
  ledgerEntries,
  ledgerAccounts,
} from "@workspace/db";
import {
  createFixtureTag,
  captureOrphanBaseline,
  teardownFixtures,
  type OrphanBaseline,
} from "./support/fixtures.js";

const FIXTURES = createFixtureTag("m25wh");
const BASE = "/api";
const WEBHOOK_SECRET = "whsec_test_m25_atomicity";

/** Distinct event IDs racing to post the same payment intent. */
const RACERS = 10;

// ─── Stripe mock ─────────────────────────────────────────────────────────────
// Stripe network calls are mocked. Every database operation is real.

vi.mock("../lib/stripe.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/stripe.js")>();
  return { ...actual, getStripeClient: vi.fn() };
});

vi.mock("../lib/stripe-customer.ts", () => ({
  getOrCreateStripeCustomer: vi.fn().mockResolvedValue("cus_m25_mock"),
}));

import { getStripeClient } from "../lib/stripe.js";
import { getOrCreateStripeCustomer } from "../lib/stripe-customer.js";
import {
  postContributionAccounting,
  postContributionAccountingInTx,
} from "../lib/ledger.js";

const mockGetStripeClient = vi.mocked(getStripeClient);
const mockGetOrCreateStripeCustomer = vi.mocked(getOrCreateStripeCustomer);

let _piCounter = 0;

function buildMockStripe() {
  return {
    paymentIntents: {
      create: vi.fn().mockImplementation(async () => {
        const id = `pi_m25_${++_piCounter}_${Date.now()}`;
        return {
          id,
          client_secret: `${id}_secret`,
          amount: 21_246,
          currency: "usd",
          status: "requires_payment_method",
          latest_charge: null,
        };
      }),
      retrieve: vi.fn(),
    },
    customerSessions: {
      create: vi.fn().mockResolvedValue({ client_secret: "cuss_m25_secret" }),
    },
    customers: { create: vi.fn().mockResolvedValue({ id: "cus_m25_mock" }) },
    webhooks: { constructEvent: vi.fn() },
    charges: {
      retrieve: vi.fn().mockRejectedValue(new Error("Not available in test mode")),
    },
    // Stripe's client type is far larger than the handful of members the
    // webhook path touches, and there is no partial-mock helper for it. Same
    // assertion, for the same reason, as `phase4b-webhook-concurrency.test.ts`.
  } as unknown as ReturnType<typeof getStripeClient>;
}

let mockStripe: ReturnType<typeof buildMockStripe>;

// ─── A private pool, separate from the application pool ──────────────────────
//
// Two things below need a connection that is NOT one of the application pool's
// ten: the gate that holds a row lock while all ten deliveries pile up behind
// it, and the probe that watches them do so. Taking either from `pool` would
// spend a connection the deliveries need and turn this file's own
// instrumentation into the contention it is trying to measure.
//
// This does not enlarge the production pool. `@workspace/db`'s pool keeps its
// default `max: 10` — Part II asserts that — and nothing here is reachable from
// production code. `pg` is not a declared dependency of this package, so the
// pool class is taken from the running instance rather than imported; the type
// side comes from `@types/pg`, which is declared.

// `Object.prototype.constructor` is typed `Function`, which carries no
// construct signature, so recovering the pool class from a live instance needs
// an assertion. It is checked at runtime by the first `createPrivatePool` call:
// a wrong class would throw here rather than mis-typing anything downstream.
type PoolConstructor = new (config: PoolConfig) => PgPool;
const PgPoolClass = pool.constructor as unknown as PoolConstructor;

function createPrivatePool(config: PoolConfig): PgPool {
  const connectionString = process.env["DATABASE_URL"];
  if (!connectionString) throw new Error("DATABASE_URL is not set");
  return new PgPoolClass({ connectionString, ...config });
}

/**
 * Pool for the gate and the probe. Two connections, and a short acquire
 * timeout so a plumbing mistake in this file surfaces as a fast failure rather
 * than as the very hang it exists to detect.
 */
const supportPool = createPrivatePool({ max: 2, connectionTimeoutMillis: 10_000 });

// ─── Deadlines ───────────────────────────────────────────────────────────────

/**
 * Bound a promise. A regression of the deadlock this file guards makes the work
 * below wait forever — node-postgres is configured with
 * `connectionTimeoutMillis: 0` — so every await that could be affected is
 * wrapped. A blown deadline fails the test; it never downgrades an assertion.
 */
async function withDeadline<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `[M2.5 DEADLINE] ${what} did not finish within ${ms}ms. A pool ` +
                  `deadlock is the expected cause: the webhook handler must not ` +
                  `take a second connection while holding its outer transaction.`,
              ),
            ),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Poll `check` until it returns true, or fail on the deadline.
 *
 * This is a barrier, not a sleep: it advances the moment the database reports
 * the condition, and the condition — "N backends are blocked on the gate's
 * lock" — is the thing the test needs to be true before it proceeds.
 */
async function until(
  check: () => Promise<boolean>,
  ms: number,
  what: string,
): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await check()) return;
    if (Date.now() >= deadline) {
      throw new Error(`[M2.5 BARRIER] ${what} was not reached within ${ms}ms.`);
    }
    await new Promise<void>((r) => setImmediate(r));
  }
}

/**
 * An n-party rendezvous: every caller blocks until the last one arrives.
 *
 * Part I needs both outer transactions to be holding a connection *before*
 * either asks for a second one. Without that, the two tasks can simply take
 * turns — one finishes and frees its connection before the other starts — and
 * the starvation the test exists to demonstrate never occurs. This makes the
 * overlap a fact rather than a scheduling accident.
 */
function rendezvous(parties: number): () => Promise<void> {
  let arrived = 0;
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  return async () => {
    if (++arrived >= parties) open();
    await gate;
  };
}

// ─── Fixture helpers ─────────────────────────────────────────────────────────

async function register(suffix: string) {
  const email = FIXTURES.email(suffix);
  const res = await request(app)
    .post(`${BASE}/auth/register`)
    .send({ email, password: "P@ssword1!", firstName: "M25", lastName: "Atomicity" });
  expect(res.status, `register ${suffix}: ${JSON.stringify(res.body)}`).toBe(201);
  return { token: res.body.token as string, userId: res.body.user.id as string };
}

async function createLaunchedJar(token: string) {
  const created = await request(app)
    .post(`${BASE}/jars`)
    .set("Authorization", `Bearer ${token}`)
    .send({
      name: FIXTURES.name("M25 Jar"),
      targetDate: "2027-12-31",
      goalAmountCents: 500_000,
      currency: "USD",
    });
  expect(created.status, `createJar: ${JSON.stringify(created.body)}`).toBe(201);
  const launched = await request(app)
    .post(`${BASE}/jars/${created.body.id}/launch`)
    .set("Authorization", `Bearer ${token}`);
  expect(launched.status, `launchJar: ${JSON.stringify(launched.body)}`).toBe(200);
  return created.body as { id: string };
}

async function memberIdFor(jarId: string, userId: string) {
  const [m] = await db
    .select({ id: jarMembers.id })
    .from(jarMembers)
    .where(and(eq(jarMembers.jarId, jarId), eq(jarMembers.userId, userId)));
  if (!m) throw new Error(`Member not found: jar=${jarId} user=${userId}`);
  return m.id;
}

async function quoteAndPaymentIntent(token: string, jarId: string) {
  const quote = await request(app)
    .post(`${BASE}/finance/quote`)
    .set("Authorization", `Bearer ${token}`)
    .send({ principalCents: 20_000, paymentMethodType: "card", jarId });
  expect(quote.status, `quote: ${JSON.stringify(quote.body)}`).toBe(200);
  const { financialTransactionId } = quote.body as { financialTransactionId: string };

  await request(app)
    .post(`${BASE}/jars/${jarId}/drips/payment-intent`)
    .set("Authorization", `Bearer ${token}`)
    .send({ financialTransactionId });

  const [ft] = await db
    .select()
    .from(financialTransactions)
    .where(eq(financialTransactions.id, financialTransactionId));
  if (!ft) throw new Error(`FT missing after PI creation: ${financialTransactionId}`);
  return ft;
}

function successEvent(
  ft: typeof financialTransactions.$inferSelect,
  eventId: string,
) {
  return {
    id: eventId,
    type: "payment_intent.succeeded",
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: ft.providerTransactionId,
        object: "payment_intent",
        amount: ft.totalQuotedCents,
        currency: ft.currency.toLowerCase(),
        status: "succeeded",
        latest_charge: null,
        metadata: { financialTransactionId: ft.id, jarId: ft.jarId, memberId: ft.memberId },
      },
    },
  };
}

function deliver(event: unknown) {
  return request(app)
    .post(`${BASE}/webhooks/stripe`)
    .set("Content-Type", "application/json")
    .set("stripe-signature", `t=${Math.floor(Date.now() / 1000)},v1=mock`)
    .send(Buffer.from(JSON.stringify(event)));
}

/** Ledger entries of one posting, keyed by account code and direction. */
async function entriesOf(ledgerTransactionId: string) {
  return db
    .select({
      entryType: ledgerEntries.entryType,
      amountCents: ledgerEntries.amountCents,
      accountCode: ledgerAccounts.code,
    })
    .from(ledgerEntries)
    .innerJoin(ledgerAccounts, eq(ledgerEntries.accountId, ledgerAccounts.id))
    .where(eq(ledgerEntries.ledgerTransactionId, ledgerTransactionId));
}

// ─────────────────────────────────────────────────────────────────────────────
// PART I — the deadlock mechanism, proven structurally
// ─────────────────────────────────────────────────────────────────────────────

describe("M2.5 Part I — nested transactions need a second connection", () => {
  /**
   * Two connections, and an acquire timeout so starvation is reported instead
   * of waited on. The production pool's `connectionTimeoutMillis` is 0, which
   * is exactly why the original defect hung rather than failing; reproducing
   * the shape with a finite timeout shows the same starvation in bounded time.
   */
  const tinyPool = createPrivatePool({ max: 2, connectionTimeoutMillis: 2_000 });
  const tinyDb = drizzle(tinyPool);

  afterAll(async () => {
    await tinyPool.end();
  });

  it("the OLD shape starves at pool capacity — one connection per nested transaction", async () => {
    // Each task opens an outer transaction and then, from inside it, opens a
    // second independent transaction on the same pool. That is precisely what
    // `routes/stripe-webhooks.ts` did when it called `postContributionAccounting`.
    //
    // Both outer transactions are established before either asks for its inner
    // one, so both connections are provably held when the demand for a third
    // arrives. There is no third; the pool holds two.
    const bothOuterOpen = rendezvous(2);
    const nested = () =>
      tinyDb.transaction(async (tx) => {
        await tx.execute(drizzleSql`select 1`);
        await bothOuterOpen();
        // Second, independent transaction — a second connection.
        return tinyDb.transaction(async (inner) => inner.execute(drizzleSql`select 1`));
      });

    const outcome = await withDeadline(
      Promise.allSettled([nested(), nested()]),
      30_000,
      "old-shape reproduction",
    );

    const rejected = outcome.filter((r) => r.status === "rejected");
    expect(
      rejected.length,
      "both outer transactions hold a connection, so neither inner one can be served",
    ).toBe(2);
    for (const r of rejected) {
      const message = String((r as PromiseRejectedResult).reason?.message ?? "");
      expect(message.toLowerCase()).toContain("timeout");
    }
  });

  it("the NEW shape completes at the same capacity — one connection per transaction", async () => {
    // Same concurrency, same pool, same rendezvous: both transactions are open
    // at once. All work runs on the executor the transaction already owns, so
    // nothing asks for a second connection and both drain.
    const bothOpen = rendezvous(2);
    const flat = () =>
      tinyDb.transaction(async (tx) => {
        await tx.execute(drizzleSql`select 1`);
        await bothOpen();
        await tx.execute(drizzleSql`select count(*) from ledger_accounts`);
        return "ok";
      });

    const results = await withDeadline(
      Promise.all([flat(), flat()]),
      30_000,
      "new-shape reproduction",
    );
    expect(results).toEqual(["ok", "ok"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PART II — ten concurrent distinct event IDs against one payment intent
// ─────────────────────────────────────────────────────────────────────────────

describe("M2.5 Part II — ten overlapping deliveries post exactly once", () => {
  let ft: typeof financialTransactions.$inferSelect;
  let memberId: string;

  beforeAll(async () => {
    mockStripe = buildMockStripe();
    mockGetStripeClient.mockReturnValue(mockStripe);
    mockGetOrCreateStripeCustomer.mockResolvedValue("cus_m25_mock");
    process.env["STRIPE_WEBHOOK_SECRET"] = WEBHOOK_SECRET;

    const user = await register("racer");
    const jar = await createLaunchedJar(user.token);
    memberId = await memberIdFor(jar.id, user.userId);
    ft = await quoteAndPaymentIntent(user.token, jar.id);
  }, 90_000);

  it(
    "ten deliveries overlap inside their transactions, need ten connections, and produce one contribution",
    { timeout: 120_000 },
    async () => {
      const events = Array.from({ length: RACERS }, (_, i) =>
        successEvent(ft, `evt_m25_race_${i}_${Date.now()}`),
      );

      // Each request receives a distinct event ID, so these are ten genuinely
      // different Stripe events converging on one payment intent.
      let dispatch = 0;
      (mockStripe.webhooks.constructEvent as ReturnType<typeof vi.fn>).mockImplementation(
        () => events[dispatch++ % events.length],
      );

      const gate: PoolClient = await supportPool.connect();
      const probe: PoolClient = await supportPool.connect();
      let gateOpen = true;

      let blockedPeak = 0;
      let busyAtBarrier = 0;

      try {
        // ── Gate: hold the financial-transaction row lock ──────────────────
        await gate.query("begin");
        await gate.query(
          "select id from financial_transactions where id = $1 for update",
          [ft.id],
        );
        const gatePid = (await gate.query<{ pid: number }>("select pg_backend_pid() pid"))
          .rows[0]!.pid;

        // ── Fire all ten. Not awaited yet — they must pile up on the gate. ──
        const inFlight = Promise.all(events.map((e) => deliver(e)));

        // ── Barrier: wait until every delivery is blocked on OUR lock ───────
        //
        // `pg_blocking_pids` scopes this to backends this test is blocking, so
        // other test files running in parallel against the same database
        // cannot inflate it. The pid identifies the gate connection for
        // synchronisation only — no assertion below is derived from it.
        await until(
          async () => {
            const blocked = Number(
              (
                await probe.query<{ c: string }>(
                  `select count(*)::int c from pg_stat_activity
                    where datname = current_database()
                      and $1 = any(pg_blocking_pids(pid))`,
                  [gatePid],
                )
              ).rows[0]!.c,
            );
            blockedPeak = Math.max(blockedPeak, blocked);
            return blocked >= RACERS;
          },
          60_000,
          `all ${RACERS} deliveries blocked on the financial-transaction row lock`,
        );

        busyAtBarrier = pool.totalCount - pool.idleCount;

        // ── Release. Everything now has to drain on the pool it already holds.
        await gate.query("commit");
        gateOpen = false;

        const responses = await withDeadline(
          inFlight,
          60_000,
          `${RACERS} concurrent deliveries draining after the gate released`,
        );

        expect(
          responses.map((r) => r.status).filter((s) => s !== 200),
          "every delivery returns 200",
        ).toEqual([]);
      } finally {
        if (gateOpen) await gate.query("rollback").catch(() => {});
        gate.release();
        probe.release();
      }

      // ── (1) The deliveries genuinely overlapped ──────────────────────────
      // Serial execution would never put more than one backend behind the
      // gate at a time.
      expect(
        blockedPeak,
        `only ${blockedPeak} deliveries were ever blocked at once — they ran serially`,
      ).toBe(RACERS);

      // ── (2) Ten in-flight outer transactions cost ten connections ────────
      // The old nested shape needed two apiece. Twenty is not available: the
      // pool's maximum is ten, which is what made the defect a hang.
      expect(pool.options.max, "production pool size is unchanged").toBe(10);
      expect(
        busyAtBarrier,
        `${RACERS} blocked transactions occupied ${busyAtBarrier} connections`,
      ).toBeLessThanOrEqual(pool.options.max);
      expect(busyAtBarrier).toBeGreaterThanOrEqual(RACERS);

      // ── (3) One event row per event ID, all terminal and processed ───────
      for (const e of events) {
        const rows = await db
          .select()
          .from(stripeWebhookEvents)
          .where(eq(stripeWebhookEvents.stripeEventId, e.id));
        expect(rows, `exactly one event row for ${e.id}`).toHaveLength(1);
        expect(rows[0]!.processingStatus, `terminal state for ${e.id}`).toBe("processed");
        expect(rows[0]!.processedAt, `processedAt set for ${e.id}`).toBeTruthy();
        expect(rows[0]!.financialTransactionId, `event linked for ${e.id}`).toBe(ft.id);
      }

      // ── (4) Exactly one contribution for this payment intent ─────────────
      const contribs = await db
        .select()
        .from(contributions)
        .where(eq(contributions.externalPaymentId, ft.providerTransactionId!));
      expect(contribs, "exactly one contribution").toHaveLength(1);
      expect(contribs[0]!.amountCents).toBe(Number(ft.requestedPrincipalCents));
      expect(contribs[0]!.jarId).toBe(ft.jarId);
      expect(contribs[0]!.memberId).toBe(memberId);

      // ── (5) The financial transaction posted exactly once ────────────────
      const [posted] = await db
        .select()
        .from(financialTransactions)
        .where(eq(financialTransactions.id, ft.id));
      expect(posted!.providerStatus).toBe("succeeded");
      expect(posted!.ledgerPostingStatus).toBe("posted");
      expect(posted!.ledgerId).toBeTruthy();

      // ── (6) One ledger transaction, with exactly the expected entries ────
      const entries = await entriesOf(posted!.ledgerId!);
      const debits = entries.filter((e) => e.entryType === "debit");
      const credits = entries.filter((e) => e.entryType === "credit");
      const sum = (rows: typeof entries) =>
        rows.reduce((t, e) => t + Number(e.amountCents), 0);

      expect(sum(debits), "ledger balances").toBe(sum(credits));
      expect(sum(debits), "total charged").toBe(Number(ft.totalQuotedCents));

      const amountFor = (code: string, type: "debit" | "credit") => {
        const matched = entries.filter((e) => e.accountCode === code && e.entryType === type);
        expect(matched, `${code} ${type} appears exactly once`).toHaveLength(1);
        return Number(matched[0]!.amountCents);
      };

      expect(amountFor("EXT_PAY_CLR", "debit")).toBe(Number(ft.totalQuotedCents));
      expect(amountFor("CTRB_REFUNDABLE", "credit")).toBe(Number(ft.requestedPrincipalCents));
      expect(amountFor("DJ_FEE_REVENUE", "credit")).toBe(
        Number(ft.totalQuotedCents) -
          Number(ft.requestedPrincipalCents) -
          Number(ft.processingFeeEstimatedCents),
      );
      if (Number(ft.processingFeeEstimatedCents) > 0) {
        expect(amountFor("PROC_FEE_CLR", "credit")).toBe(
          Number(ft.processingFeeEstimatedCents),
        );
      }

      // ── (7) No duplicate financial effect anywhere for this PI ───────────
      // The webhook posts under a payment-intent-scoped idempotency key, so a
      // second posting by any of the ten losers would show up here.
      const byKey = await db
        .select({ id: financialTransactions.id })
        .from(financialTransactions)
        .where(
          eq(
            financialTransactions.idempotencyKey,
            `stripe-webhook:${ft.providerTransactionId}`,
          ),
        );
      expect(byKey, "one webhook-keyed financial transaction").toHaveLength(1);

      const postings = await db
        .select({ id: ledgerTransactions.id })
        .from(ledgerTransactions)
        .where(eq(ledgerTransactions.financialTransactionId, byKey[0]!.id));
      expect(postings, "one ledger transaction for the posting").toHaveLength(1);
      expect(postings[0]!.id).toBe(posted!.ledgerId);
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// PART III — atomicity, rollback, and recovery
// ─────────────────────────────────────────────────────────────────────────────

describe("M2.5 Part III — accounting commits or rolls back as one unit", () => {
  let jarId: string;
  let memberId: string;

  beforeAll(async () => {
    const user = await register("atomic");
    const jar = await createLaunchedJar(user.token);
    jarId = jar.id;
    memberId = await memberIdFor(jar.id, user.userId);
  }, 90_000);

  /** Everything a posting under `key` left behind, counted from the database. */
  async function effectsOf(key: string) {
    const fts = await db
      .select({ id: financialTransactions.id, ledgerId: financialTransactions.ledgerId })
      .from(financialTransactions)
      .where(eq(financialTransactions.idempotencyKey, key));

    let ledgerTxCount = 0;
    let entryCount = 0;
    for (const f of fts) {
      const txs = await db
        .select({ id: ledgerTransactions.id })
        .from(ledgerTransactions)
        .where(eq(ledgerTransactions.financialTransactionId, f.id));
      ledgerTxCount += txs.length;
      for (const t of txs) entryCount += (await entriesOf(t.id)).length;
    }
    return { financialTransactions: fts.length, ledgerTxCount, entryCount, fts };
  }

  it("a failure after the accounting work but before COMMIT leaves nothing behind", async () => {
    const key = `m25-thrown-${FIXTURES.tag}`;
    const marker = `m25-marker-${FIXTURES.tag}`;

    await expect(
      db.transaction(async (tx) => {
        // The full accounting, on this transaction's executor.
        const posted = await postContributionAccountingInTx(tx, {
          jarId,
          memberId,
          principalCents: 20_000,
          estimatedProcessingFeeCents: 160,
          idempotencyKey: key,
        });
        expect(posted.ledgerTransactionId, "accounting ran to completion").toBeTruthy();

        // The rest of what the webhook handler does after posting.
        await tx.insert(contributions).values({
          jarId,
          memberId,
          amountCents: 20_000,
          contributionDate: new Date().toISOString().slice(0, 10),
          status: "stripe_test",
          sourceType: "stripe_test",
          externalPaymentId: marker,
        });

        // Now fail, exactly where a notification or a status write could.
        throw new Error("m25 injected failure before commit");
      }),
    ).rejects.toThrow("m25 injected failure before commit");

    const after = await effectsOf(key);
    expect(after.financialTransactions, "no financial transaction survived").toBe(0);
    expect(after.ledgerTxCount, "no ledger transaction survived").toBe(0);
    expect(after.entryCount, "no ledger entry survived").toBe(0);

    const orphanContribs = await db
      .select()
      .from(contributions)
      .where(eq(contributions.externalPaymentId, marker));
    expect(orphanContribs, "no contribution survived").toHaveLength(0);
  });

  it("an explicit rollback removes every accounting effect", async () => {
    const key = `m25-rolledback-${FIXTURES.tag}`;

    await expect(
      db.transaction(async (tx) => {
        await postContributionAccountingInTx(tx, {
          jarId,
          memberId,
          principalCents: 12_500,
          idempotencyKey: key,
        });
        // Drizzle signals rollback by throwing its own sentinel.
        tx.rollback();
      }),
    ).rejects.toThrow();

    const after = await effectsOf(key);
    expect(after.financialTransactions).toBe(0);
    expect(after.ledgerTxCount).toBe(0);
    expect(after.entryCount).toBe(0);
  });

  it("a legitimate retry after a rolled-back attempt succeeds exactly once", async () => {
    const key = `m25-retry-${FIXTURES.tag}`;

    // First attempt: complete accounting, then fail before commit.
    await expect(
      db.transaction(async (tx) => {
        await postContributionAccountingInTx(tx, {
          jarId,
          memberId,
          principalCents: 20_000,
          estimatedProcessingFeeCents: 160,
          idempotencyKey: key,
        });
        throw new Error("m25 first attempt fails");
      }),
    ).rejects.toThrow("m25 first attempt fails");

    expect((await effectsOf(key)).financialTransactions, "first attempt left nothing").toBe(0);

    // Retry, committing this time.
    const retried = await db.transaction((tx) =>
      postContributionAccountingInTx(tx, {
        jarId,
        memberId,
        principalCents: 20_000,
        estimatedProcessingFeeCents: 160,
        idempotencyKey: key,
      }),
    );

    const after = await effectsOf(key);
    expect(after.financialTransactions, "exactly one financial transaction").toBe(1);
    expect(after.ledgerTxCount, "exactly one ledger transaction").toBe(1);
    expect(after.entryCount, "four entries: charge, principal, fee, processing").toBe(4);
    expect(after.fts[0]!.ledgerId).toBe(retried.ledgerTransactionId);

    // A third delivery of the same key must add nothing.
    const again = await db.transaction((tx) =>
      postContributionAccountingInTx(tx, {
        jarId,
        memberId,
        principalCents: 20_000,
        estimatedProcessingFeeCents: 160,
        idempotencyKey: key,
      }),
    );
    expect(again.ledgerTransactionId, "idempotent replay returns the same posting").toBe(
      retried.ledgerTransactionId,
    );
    const afterReplay = await effectsOf(key);
    expect(afterReplay.financialTransactions).toBe(1);
    expect(afterReplay.ledgerTxCount).toBe(1);
    expect(afterReplay.entryCount).toBe(4);
  });

  it("the standalone caller still opens its own transaction and commits", async () => {
    const key = `m25-standalone-${FIXTURES.tag}`;

    // No enclosing transaction — exactly how every non-webhook caller uses it.
    const result = await postContributionAccounting({
      jarId,
      memberId,
      principalCents: 30_000,
      estimatedProcessingFeeCents: 240,
      idempotencyKey: key,
    });

    const after = await effectsOf(key);
    expect(after.financialTransactions, "committed without an outer transaction").toBe(1);
    expect(after.ledgerTxCount).toBe(1);
    expect(after.entryCount).toBe(4);
    expect(after.fts[0]!.ledgerId).toBe(result.ledgerTransactionId);

    const entries = await entriesOf(result.ledgerTransactionId);
    const debits = entries.filter((e) => e.entryType === "debit");
    const credits = entries.filter((e) => e.entryType === "credit");
    const sum = (rows: typeof entries) => rows.reduce((t, e) => t + Number(e.amountCents), 0);
    expect(sum(debits), "standalone posting balances").toBe(sum(credits));

    // 30 000 principal + 3% DripJar fee (900) + 240 processing = 31 140.
    expect(sum(debits)).toBe(31_140);

    // Replaying the same key returns the same posting rather than making one.
    const replay = await postContributionAccounting({
      jarId,
      memberId,
      principalCents: 30_000,
      estimatedProcessingFeeCents: 240,
      idempotencyKey: key,
    });
    expect(replay.ledgerTransactionId).toBe(result.ledgerTransactionId);
    expect((await effectsOf(key)).ledgerTxCount).toBe(1);
  });
});

// ─── Teardown ────────────────────────────────────────────────────────────────

let baseline: OrphanBaseline;

beforeAll(async () => {
  baseline = await captureOrphanBaseline();
});

afterAll(async () => {
  await supportPool.end();
  await teardownFixtures(FIXTURES, {
    baseline,
    restore: () => {
      delete process.env["STRIPE_WEBHOOK_SECRET"];
      vi.restoreAllMocks();
    },
  });
});
