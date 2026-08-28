/**
 * Phase 2B1 — Canonical Server-Side Financial Notifications
 *
 * Proves that a customer-visible financial notification exists if and only if
 * canonical accounting says the thing it describes happened, and that it
 * exists exactly once however many times the trigger is delivered.
 *
 * Mocked : Stripe network + signature verification (lib/stripe.js).
 * REAL   : PostgreSQL, the ledger, the full Express webhook pipeline, and
 *          every notification code path under test.
 *
 * No email, push, or SMS is sent. `RESEND_API_KEY` is unset in the validation
 * environment, which suppresses delivery at the transport, and the assertions
 * below only ever read `notifications` and `reminder_sent_events`.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import { db, pool } from "@workspace/db";
import {
  jars,
  jarMembers,
  contributions,
  milestones,
  notifications,
  financialTransactions,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";

vi.mock("../lib/stripe.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/stripe.js")>();
  return { ...actual, getStripeClient: vi.fn() };
});

vi.mock("../lib/stripe-customer.ts", () => ({
  getOrCreateStripeCustomer: vi.fn().mockResolvedValue("cus_2b1_mock"),
}));

import { getStripeClient } from "../lib/stripe.js";
import app from "../app.js";
import { postContributionAccounting, clearLedgerAccountCache } from "../lib/ledger.js";
import { purgeSyntheticAccounts } from "../lib/owner-reset.js";
import { withGlobalSweepExclusion } from "./support/fixtures.js";
import {
  notifyJarProgressThresholds,
  notifyMilestonesFunded,
  notifySettledContribution,
} from "../lib/notification-financial.js";

const BASE = "/api";
const mockGetStripeClient = vi.mocked(getStripeClient);

/**
 * One tag for the whole file, fixed before any fixture is built. Teardown
 * resolves fixtures by querying for this tag, never from a value a setup
 * helper returned — a helper that throws half-way through still leaves
 * findable rows, which is exactly when cleanup matters most.
 */
const FIXTURE_TAG = `n2b1${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const TAGGED_EMAIL_LIKE = `%-${FIXTURE_TAG}@test.invalid`;
const TAGGED_JAR_LIKE = `%${FIXTURE_TAG}%`;

let uniqCounter = 0;
const uniq = () => `${++uniqCounter}`;
const taggedEmail = (suffix: string) => `notif-${suffix}${uniq()}-${FIXTURE_TAG}@test.invalid`;

const WEBHOOK_SECRET = "whsec_test_phase2b1";

// ─── Stripe mock ─────────────────────────────────────────────────────────────

let piCounter = 0;
/** Events keyed by the raw body we will post, so constructEvent is pure. */
const eventByBody = new Map<string, unknown>();

function buildMockStripe() {
  return {
    paymentIntents: {
      create: vi.fn().mockImplementation(async () => {
        const id = `pi_2b1_${++piCounter}_${Date.now()}`;
        return { id, client_secret: `${id}_secret`, amount: 0, currency: "usd", status: "requires_payment_method", latest_charge: null };
      }),
      retrieve: vi.fn(),
    },
    customerSessions: { create: vi.fn().mockResolvedValue({ client_secret: "cuss_2b1" }) },
    customers: { create: vi.fn().mockResolvedValue({ id: "cus_2b1_mock" }) },
    charges: { retrieve: vi.fn().mockRejectedValue(new Error("not available in test mode")) },
    webhooks: {
      constructEvent: (rawBody: Buffer | string) => {
        const key = Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : String(rawBody);
        const event = eventByBody.get(key);
        if (!event) throw new Error("Unknown test event body");
        return event;
      },
    },
  } as unknown as ReturnType<typeof getStripeClient>;
}

// ─── HTTP helpers ────────────────────────────────────────────────────────────

async function register(suffix: string) {
  const res = await request(app).post(`${BASE}/auth/register`).send({
    email: taggedEmail(suffix),
    password: "P@ssword1!",
    firstName: "Notif",
    lastName: suffix.replace(/[^a-zA-Z]/g, "") || "User",
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return { token: res.body.token as string, userId: res.body.user.id as string };
}

async function createLaunchedJar(token: string, name: string, goalAmountCents = 1_000_000) {
  const create = await request(app).post(`${BASE}/jars`).set("Authorization", `Bearer ${token}`).send({
    name: `${name} ${FIXTURE_TAG} ${uniq()}`,
    category: "Vacation",
    goalAmountCents,
    targetDate: new Date(Date.now() + 200 * 86_400_000).toISOString().slice(0, 10),
  });
  expect(create.status, JSON.stringify(create.body)).toBe(201);
  const jarId = create.body.id as string;
  const launch = await request(app).post(`${BASE}/jars/${jarId}/launch`).set("Authorization", `Bearer ${token}`);
  expect(launch.status, JSON.stringify(launch.body)).toBe(200);
  return jarId;
}

/**
 * Accept the jar's auto-created agreement so the money-in agreement gate is
 * satisfied. Launching a jar creates an agreement, and `enforceAgreement`
 * answers 409 `AgreementRequired` until the caller accepts it — so any test
 * that needs a contribution route to actually execute must call this first.
 * Same pattern as `commitment-lifecycle-gate.test.ts`.
 */
async function acceptAgreement(jarId: string, token: string) {
  const status = await request(app)
    .get(`${BASE}/jars/${jarId}/agreements/status`)
    .set("Authorization", `Bearer ${token}`);
  const agreementId = status.body?.agreementId as string | undefined;
  if (!agreementId) return;
  await request(app)
    .post(`${BASE}/jars/${jarId}/agreements/${agreementId}/accept`)
    .set("Authorization", `Bearer ${token}`);
}

async function memberIdFor(jarId: string, userId: string) {
  const [m] = await db
    .select({ id: jarMembers.id })
    .from(jarMembers)
    .where(and(eq(jarMembers.jarId, jarId), eq(jarMembers.userId, userId)));
  return m!.id;
}

/** Add a second active member directly, so tests need no invitation round-trip. */
async function addActiveMember(jarId: string, userId: string) {
  const [m] = await db
    .insert(jarMembers)
    .values({ jarId, userId, role: "member", status: "active" })
    .returning({ id: jarMembers.id });
  return m!.id;
}

/**
 * A settled, ledger-posted contribution lot — the canonical shape.
 * `principalCents` is principal only; fees are passed separately exactly as
 * the real posting does, so the fee-exclusion assertions are meaningful.
 */
async function seedSettledLot(
  jarId: string,
  memberId: string,
  principalCents: number,
  estimatedProcessingFeeCents = 0,
) {
  clearLedgerAccountCache();
  const r = await postContributionAccounting({
    jarId,
    memberId,
    principalCents,
    estimatedProcessingFeeCents,
  });
  const providerTransactionId = `pi_seed_${uniq()}_${Date.now()}`;
  await db
    .update(financialTransactions)
    .set({ providerType: "stripe", providerStatus: "succeeded", providerTransactionId })
    .where(eq(financialTransactions.id, r.financialTransactionId));
  return { ftId: r.financialTransactionId, providerTransactionId };
}

/** Quote + payment intent: a real FT that has NOT settled. */
async function createUnsettledFt(token: string, jarId: string, principalCents: number) {
  const quote = await request(app)
    .post(`${BASE}/finance/quote`)
    .set("Authorization", `Bearer ${token}`)
    .send({ principalCents, paymentMethodType: "card", jarId });
  expect(quote.status, JSON.stringify(quote.body)).toBe(200);
  const financialTransactionId = quote.body.financialTransactionId as string;

  await request(app)
    .post(`${BASE}/jars/${jarId}/drips/payment-intent`)
    .set("Authorization", `Bearer ${token}`)
    .send({ financialTransactionId });

  const [ft] = await db.select().from(financialTransactions).where(eq(financialTransactions.id, financialTransactionId));
  return ft!;
}

function buildSuccessEvent(ft: typeof financialTransactions.$inferSelect, eventId?: string) {
  return {
    id: eventId ?? `evt_2b1_${uniq()}_${Date.now()}`,
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
        metadata: {},
      },
    },
  };
}

function buildFailedEvent(ft: typeof financialTransactions.$inferSelect) {
  return {
    id: `evt_2b1_fail_${uniq()}_${Date.now()}`,
    type: "payment_intent.payment_failed",
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: ft.providerTransactionId,
        object: "payment_intent",
        amount: ft.totalQuotedCents,
        currency: ft.currency.toLowerCase(),
        status: "requires_payment_method",
        last_payment_error: { code: "card_declined", message: "Your card was declined by the issuing bank." },
        metadata: {},
      },
    },
  };
}

function sendWebhook(event: unknown) {
  const payload = JSON.stringify(event);
  eventByBody.set(payload, event);
  return request(app)
    .post(`${BASE}/webhooks/stripe`)
    .set("Content-Type", "application/json")
    .set("stripe-signature", `t=${Math.floor(Date.now() / 1000)},v1=mock`)
    .send(payload);
}

// ─── Assertion helpers ───────────────────────────────────────────────────────

async function notificationsFor(userId: string, jarId?: string) {
  const rows = await db
    .select({ id: notifications.id, type: notifications.type, title: notifications.title, message: notifications.message, relatedJarId: notifications.relatedJarId })
    .from(notifications)
    .where(jarId ? and(eq(notifications.userId, userId), eq(notifications.relatedJarId, jarId)) : eq(notifications.userId, userId));
  return rows;
}

const ofType = (rows: Awaited<ReturnType<typeof notificationsFor>>, type: string) =>
  rows.filter((r) => r.type === type);

const countRow = async (sql: string, params: unknown[] = []) =>
  Number((await pool.query(sql, params)).rows[0].c);

const ORPHAN_SQL = {
  ledgerEntries: `select count(*)::int c from ledger_entries le
                    left join ledger_transactions lt on lt.id = le.ledger_transaction_id
                   where lt.id is null`,
  ledgerTransactions: `select count(*)::int c from ledger_transactions lt
                    left join financial_transactions ft on ft.id = lt.financial_transaction_id
                   where ft.id is null`,
  financialTransactions: `select count(*)::int c from financial_transactions ft
                    left join jars j on j.id = ft.jar_id where j.id is null`,
  notifications: `select count(*)::int c from notifications n
                    left join users u on u.id = n.user_id where u.id is null`,
  reminderEvents: `select count(*)::int c from reminder_sent_events r
                    left join users u on u.id = r.user_id where u.id is null`,
} as const;

let orphanBaseline: Record<string, number>;
const originalWebhookSecret = process.env["STRIPE_WEBHOOK_SECRET"];

beforeAll(async () => {
  mockGetStripeClient.mockReturnValue(buildMockStripe());
  process.env["STRIPE_WEBHOOK_SECRET"] = WEBHOOK_SECRET;
  orphanBaseline = {
    ledgerEntries: await countRow(ORPHAN_SQL.ledgerEntries),
    ledgerTransactions: await countRow(ORPHAN_SQL.ledgerTransactions),
    financialTransactions: await countRow(ORPHAN_SQL.financialTransactions),
    notifications: await countRow(ORPHAN_SQL.notifications),
    reminderEvents: await countRow(ORPHAN_SQL.reminderEvents),
  };
});

afterAll(async () => {
  // try/finally so mocks and env are restored even if the purge throws or an
  // assertion below fails — a leaked Stripe stub or webhook secret would
  // corrupt later suites sharing this worker.
  try {
    const tagged = (
      await pool.query(`select email from users where email like $1 order by email`, [TAGGED_EMAIL_LIKE])
    ).rows.map((r) => r.email as string);

    if (tagged.length) {
      await withGlobalSweepExclusion(() =>
        purgeSyntheticAccounts(tagged, { approvedEmails: tagged, quiet: true }),
      );
    }

    expect(
      await countRow(`select count(*)::int c from jars where name like $1`, [TAGGED_JAR_LIKE]),
      "tagged jars survived the purge",
    ).toBe(0);
    expect(
      await countRow(`select count(*)::int c from users where email like $1`, [TAGGED_EMAIL_LIKE]),
      "tagged users survived the purge",
    ).toBe(0);

    // No NEW orphans. Pre-existing rows from other suites are preserved rather
    // than "cleaned up" — this file answers only for its own delta.
    for (const key of Object.keys(ORPHAN_SQL) as (keyof typeof ORPHAN_SQL)[]) {
      expect(await countRow(ORPHAN_SQL[key]), `${key} orphans increased`).toBe(orphanBaseline[key]);
    }
  } finally {
    eventByBody.clear();
    if (originalWebhookSecret === undefined) delete process.env["STRIPE_WEBHOOK_SECRET"];
    else process.env["STRIPE_WEBHOOK_SECRET"] = originalWebhookSecret;
    vi.restoreAllMocks();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Settlement gate — only posted money notifies
// ─────────────────────────────────────────────────────────────────────────────

describe("a settled-contribution notification requires provider success AND ledger posting", () => {
  it("a quoted-and-authorized payment that has not settled notifies nobody", async () => {
    const owner = await register("pend");
    const jarId = await createLaunchedJar(owner.token, "Pending");
    const ft = await createUnsettledFt(owner.token, jarId, 50_000);

    expect(ft.ledgerPostingStatus).not.toBe("posted");

    // Called directly, the way a caller that fired too early would.
    await notifySettledContribution(ft.id);

    expect(ofType(await notificationsFor(owner.userId, jarId), "contribution_recorded")).toHaveLength(0);
  });

  it("a failed payment creates no contribution, progress, or milestone notification", async () => {
    const owner = await register("fail");
    const jarId = await createLaunchedJar(owner.token, "Failed", 100_000);
    const ft = await createUnsettledFt(owner.token, jarId, 90_000);

    const res = await sendWebhook(buildFailedEvent(ft));
    expect(res.status).toBe(200);

    const [after] = await db
      .select({ providerStatus: financialTransactions.providerStatus, ledgerPostingStatus: financialTransactions.ledgerPostingStatus })
      .from(financialTransactions)
      .where(eq(financialTransactions.id, ft.id));
    expect(after!.providerStatus).toBe("failed");
    expect(after!.ledgerPostingStatus).not.toBe("posted");

    const rows = await notificationsFor(owner.userId, jarId);
    expect(ofType(rows, "contribution_recorded")).toHaveLength(0);
    expect(ofType(rows, "jar_halfway_funded")).toHaveLength(0);
    expect(ofType(rows, "goal_fully_funded")).toHaveLength(0);
    expect(ofType(rows, "milestone_funded")).toHaveLength(0);
  });

  it("a successful posted payment notifies the contributor exactly once", async () => {
    const owner = await register("succ");
    const jarId = await createLaunchedJar(owner.token, "Success", 1_000_000);
    const ft = await createUnsettledFt(owner.token, jarId, 40_000);

    const res = await sendWebhook(buildSuccessEvent(ft));
    expect(res.status).toBe(200);

    const settled = ofType(await notificationsFor(owner.userId, jarId), "contribution_recorded");
    expect(settled).toHaveLength(1);
    expect(settled[0]!.message).toContain("$400.00");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Idempotency
// ─────────────────────────────────────────────────────────────────────────────

describe("notification creation is idempotent", () => {
  it("webhook redelivery of the same event creates no duplicate", async () => {
    const owner = await register("redel");
    const jarId = await createLaunchedJar(owner.token, "Redeliver", 1_000_000);
    const ft = await createUnsettledFt(owner.token, jarId, 30_000);

    const event = buildSuccessEvent(ft);
    for (let i = 0; i < 4; i++) {
      const res = await sendWebhook(event);
      expect(res.status).toBe(200);
    }

    expect(ofType(await notificationsFor(owner.userId, jarId), "contribution_recorded")).toHaveLength(1);
  });

  it("a distinct event id for the same settled payment creates no duplicate", async () => {
    const owner = await register("evtid");
    const jarId = await createLaunchedJar(owner.token, "EventId", 1_000_000);
    const ft = await createUnsettledFt(owner.token, jarId, 30_000);

    await sendWebhook(buildSuccessEvent(ft, `evt_2b1_first_${uniq()}`));
    await sendWebhook(buildSuccessEvent(ft, `evt_2b1_second_${uniq()}`));

    expect(ofType(await notificationsFor(owner.userId, jarId), "contribution_recorded")).toHaveLength(1);
  });

  it("concurrent delivery of the same event creates no duplicate", async () => {
    const owner = await register("conc");
    const jarId = await createLaunchedJar(owner.token, "Concurrent", 1_000_000);
    const ft = await createUnsettledFt(owner.token, jarId, 30_000);

    const event = buildSuccessEvent(ft);
    const responses = await Promise.all(Array.from({ length: 8 }).map(() => sendWebhook(event)));
    expect(responses.every((r) => r.status === 200)).toBe(true);

    expect(ofType(await notificationsFor(owner.userId, jarId), "contribution_recorded")).toHaveLength(1);
  });

  it("repeated direct calls to the emitter create no duplicate", async () => {
    const owner = await register("repeat");
    const jarId = await createLaunchedJar(owner.token, "Repeat", 1_000_000);
    const memberId = await memberIdFor(jarId, owner.userId);
    const { ftId } = await seedSettledLot(jarId, memberId, 25_000);

    await Promise.all([
      notifySettledContribution(ftId),
      notifySettledContribution(ftId),
      notifySettledContribution(ftId),
    ]);
    await notifySettledContribution(ftId);

    expect(ofType(await notificationsFor(owner.userId, jarId), "contribution_recorded")).toHaveLength(1);
  });

  it("a failed payment that later succeeds produces the settled notification once", async () => {
    const owner = await register("f2s");
    const jarId = await createLaunchedJar(owner.token, "FailThenSucceed", 1_000_000);
    const ft = await createUnsettledFt(owner.token, jarId, 20_000);

    await sendWebhook(buildFailedEvent(ft));
    expect(ofType(await notificationsFor(owner.userId, jarId), "contribution_recorded")).toHaveLength(0);

    await sendWebhook(buildSuccessEvent(ft));
    const settled = ofType(await notificationsFor(owner.userId, jarId), "contribution_recorded");
    expect(settled).toHaveLength(1);
    expect(settled[0]!.message).toContain("$200.00");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Principal, never charge
// ─────────────────────────────────────────────────────────────────────────────

describe("displayed amounts are canonical principal only", () => {
  it("excludes DripJar and processing fees from the amount other members see", async () => {
    const owner = await register("feeown");
    const other = await register("feeoth");
    const jarId = await createLaunchedJar(owner.token, "Fees", 10_000_000);
    await addActiveMember(jarId, other.userId);
    const ownerMemberId = await memberIdFor(jarId, owner.userId);

    // $500.00 principal with a $12.34 estimated processing fee. The DripJar
    // fee is computed by the posting itself at 3%.
    const { ftId } = await seedSettledLot(jarId, ownerMemberId, 50_000, 1_234);
    await notifySettledContribution(ftId);

    const [ft] = await db
      .select({
        requestedPrincipalCents: financialTransactions.requestedPrincipalCents,
        totalQuotedCents: financialTransactions.totalQuotedCents,
        dripJarFeeCents: financialTransactions.dripJarFeeCents,
      })
      .from(financialTransactions)
      .where(eq(financialTransactions.id, ftId));

    const principal = Number(ft!.requestedPrincipalCents);
    expect(principal).toBe(50_000);

    const shared = ofType(await notificationsFor(other.userId, jarId), "contribution_recorded");
    expect(shared).toHaveLength(1);
    expect(shared[0]!.message).toContain("$500.00");

    // The charge total and the fees must appear nowhere in the shared message.
    const forbidden = [
      Number(ft!.totalQuotedCents),
      Number(ft!.dripJarFeeCents),
      1_234,
    ].filter((c) => c > 0 && c !== principal);

    for (const cents of forbidden) {
      const rendered = `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      expect(shared[0]!.message, `fee/charge amount ${rendered} leaked into a shared message`).not.toContain(rendered);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Progress thresholds
// ─────────────────────────────────────────────────────────────────────────────

describe("progress notifications use canonical saved principal", () => {
  it("zero canonical principal produces no progress notification", async () => {
    const owner = await register("zeroprog");
    const jarId = await createLaunchedJar(owner.token, "ZeroProgress", 100_000);

    await notifyJarProgressThresholds(jarId);

    const rows = await notificationsFor(owner.userId, jarId);
    expect(ofType(rows, "jar_halfway_funded")).toHaveLength(0);
    expect(ofType(rows, "goal_fully_funded")).toHaveLength(0);
  });

  it("Test Mode principal alone cannot cross a threshold", async () => {
    // The exact QA contradiction: a jar showing meaningful progress while its
    // canonical principal is $0. `simulated` rows post nothing to the ledger.
    const owner = await register("testmode");
    const jarId = await createLaunchedJar(owner.token, "TestMode", 100_000);
    const memberId = await memberIdFor(jarId, owner.userId);

    await db.insert(contributions).values({
      jarId,
      memberId,
      amountCents: 71_000,
      contributionDate: new Date().toISOString().slice(0, 10),
      status: "simulated",
      sourceType: "manual",
    });

    await notifyJarProgressThresholds(jarId);

    const rows = await notificationsFor(owner.userId, jarId);
    expect(ofType(rows, "jar_halfway_funded")).toHaveLength(0);
    expect(ofType(rows, "goal_fully_funded")).toHaveLength(0);
  });

  it("crossing 50% notifies once and never repeats on recalculation", async () => {
    const owner = await register("half");
    const jarId = await createLaunchedJar(owner.token, "Halfway", 100_000);
    const memberId = await memberIdFor(jarId, owner.userId);
    await seedSettledLot(jarId, memberId, 60_000);

    await notifyJarProgressThresholds(jarId);
    await notifyJarProgressThresholds(jarId);
    await notifyJarProgressThresholds(jarId);

    const rows = await notificationsFor(owner.userId, jarId);
    const half = ofType(rows, "jar_halfway_funded");
    expect(half).toHaveLength(1);
    expect(half[0]!.message).toContain("$600.00");
    expect(ofType(rows, "goal_fully_funded")).toHaveLength(0);
  });

  it("reaching the goal emits both thresholds, each exactly once", async () => {
    const owner = await register("full");
    const jarId = await createLaunchedJar(owner.token, "FullyFunded", 100_000);
    const memberId = await memberIdFor(jarId, owner.userId);
    await seedSettledLot(jarId, memberId, 100_000);

    await notifyJarProgressThresholds(jarId);
    await notifyJarProgressThresholds(jarId);

    const rows = await notificationsFor(owner.userId, jarId);
    expect(ofType(rows, "goal_fully_funded")).toHaveLength(1);
    expect(ofType(rows, "jar_halfway_funded")).toHaveLength(1);
  });

  it("progress figures match the canonical progress surface exactly", async () => {
    const owner = await register("canon");
    const jarId = await createLaunchedJar(owner.token, "Canonical", 200_000);
    const memberId = await memberIdFor(jarId, owner.userId);
    await seedSettledLot(jarId, memberId, 150_000);
    // Test Mode money that must NOT appear in the message.
    await db.insert(contributions).values({
      jarId,
      memberId,
      amountCents: 999_00,
      contributionDate: new Date().toISOString().slice(0, 10),
      status: "simulated",
      sourceType: "manual",
    });

    await notifyJarProgressThresholds(jarId);

    const half = ofType(await notificationsFor(owner.userId, jarId), "jar_halfway_funded");
    expect(half).toHaveLength(1);
    expect(half[0]!.message).toContain("$1,500.00");
    expect(half[0]!.message).not.toContain("999");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Milestones
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the canonical funded shape for a milestone.
 *
 * `getMilestoneAllocations` attributes a posted lot to a milestone by joining
 * `financial_transactions.provider_transaction_id` to
 * `contributions.external_payment_id` and reading that row's `milestone_id`.
 * That join is constructed explicitly here — see the report's note that no
 * production money-in route currently writes the milestone tag.
 */
async function seedMilestoneFundedLot(jarId: string, memberId: string, milestoneId: string, principalCents: number) {
  const { ftId, providerTransactionId } = await seedSettledLot(jarId, memberId, principalCents);
  await db.insert(contributions).values({
    jarId,
    memberId,
    amountCents: principalCents,
    contributionDate: new Date().toISOString().slice(0, 10),
    status: "stripe_test",
    sourceType: "stripe_test",
    externalPaymentId: providerTransactionId,
    milestoneId,
  });
  return ftId;
}

async function createMilestone(jarId: string, name: string, targetAmountCents: number) {
  const [m] = await db
    .insert(milestones)
    .values({ jarId, name: `${name} ${FIXTURE_TAG}`, targetAmountCents, status: "pending" })
    .returning({ id: milestones.id });
  return m!.id;
}

describe("milestone notifications fire only on the canonical funded transition", () => {
  it("a milestone with zero canonical allocation is never funded", async () => {
    const owner = await register("msz");
    const jarId = await createLaunchedJar(owner.token, "MilestoneZero", 500_000);
    await createMilestone(jarId, "Untouched", 50_000);

    await notifyMilestonesFunded(jarId);

    expect(ofType(await notificationsFor(owner.userId, jarId), "milestone_funded")).toHaveLength(0);
  });

  it("a zero-target milestone is never funded, even with real canonical allocation", async () => {
    const owner = await register("mszt");
    const jarId = await createLaunchedJar(owner.token, "MilestoneZeroTarget", 500_000);
    const memberId = await memberIdFor(jarId, owner.userId);
    const milestoneId = await createMilestone(jarId, "ZeroTarget", 0);

    // A zero *allocation* is not constructible through the canonical path at
    // all: `generateQuote` rejects `principalCents < 1`, so no posted lot can
    // ever be worth $0. (The zero-allocation case is covered by the preceding
    // test, which leaves the milestone untagged entirely.) The reachable
    // hazard here is the zero *target*: with any real allocation present,
    // `allocated >= target` is trivially true, so only the explicit
    // `targetAmountCents <= 0` guard keeps this milestone unfunded.
    await seedMilestoneFundedLot(jarId, memberId, milestoneId, 40_000);

    await notifyMilestonesFunded(jarId);

    expect(ofType(await notificationsFor(owner.userId, jarId), "milestone_funded")).toHaveLength(0);
  });

  it("partial allocation does not fund a milestone", async () => {
    const owner = await register("msp");
    const jarId = await createLaunchedJar(owner.token, "MilestonePartial", 500_000);
    const memberId = await memberIdFor(jarId, owner.userId);
    const milestoneId = await createMilestone(jarId, "Partial", 100_000);
    await seedMilestoneFundedLot(jarId, memberId, milestoneId, 40_000);

    await notifyMilestonesFunded(jarId);

    expect(ofType(await notificationsFor(owner.userId, jarId), "milestone_funded")).toHaveLength(0);
  });

  it("reaching the target notifies once and does not repeat", async () => {
    const owner = await register("msf");
    const jarId = await createLaunchedJar(owner.token, "MilestoneFunded", 500_000);
    const memberId = await memberIdFor(jarId, owner.userId);
    const milestoneId = await createMilestone(jarId, "Flights", 100_000);
    await seedMilestoneFundedLot(jarId, memberId, milestoneId, 100_000);

    await notifyMilestonesFunded(jarId);
    await notifyMilestonesFunded(jarId);
    await notifyMilestonesFunded(jarId);

    const funded = ofType(await notificationsFor(owner.userId, jarId), "milestone_funded");
    expect(funded).toHaveLength(1);
    expect(funded[0]!.title).toContain("Flights");
  });

  it("an unsettled payment cannot fund a milestone", async () => {
    const owner = await register("msu");
    const jarId = await createLaunchedJar(owner.token, "MilestoneUnsettled", 500_000);
    const memberId = await memberIdFor(jarId, owner.userId);
    const milestoneId = await createMilestone(jarId, "Unsettled", 50_000);

    // A quoted FT that never posted, tagged to the milestone. Posted-only
    // attribution must ignore it entirely.
    const ft = await createUnsettledFt(owner.token, jarId, 50_000);
    await db.insert(contributions).values({
      jarId,
      memberId,
      amountCents: 50_000,
      contributionDate: new Date().toISOString().slice(0, 10),
      status: "pending",
      sourceType: "stripe_test",
      externalPaymentId: ft.providerTransactionId,
      milestoneId,
    });

    await notifyMilestonesFunded(jarId);

    expect(ofType(await notificationsFor(owner.userId, jarId), "milestone_funded")).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Recipients and privacy
// ─────────────────────────────────────────────────────────────────────────────

describe("recipient sets are exact", () => {
  it("a settled contribution reaches every active member and nobody else", async () => {
    const owner = await register("rcown");
    const active = await register("rcact");
    const left = await register("rcleft");
    const removed = await register("rcrem");
    const stranger = await register("rcstr");

    const jarId = await createLaunchedJar(owner.token, "Recipients", 10_000_000);
    await addActiveMember(jarId, active.userId);
    const leftMemberId = await addActiveMember(jarId, left.userId);
    const removedMemberId = await addActiveMember(jarId, removed.userId);

    await db.update(jarMembers).set({ status: "left" }).where(eq(jarMembers.id, leftMemberId));
    await db.update(jarMembers).set({ status: "removed" }).where(eq(jarMembers.id, removedMemberId));

    const ownerMemberId = await memberIdFor(jarId, owner.userId);
    const { ftId } = await seedSettledLot(jarId, ownerMemberId, 30_000);
    await notifySettledContribution(ftId);

    expect(ofType(await notificationsFor(owner.userId, jarId), "contribution_recorded"), "contributor").toHaveLength(1);
    expect(ofType(await notificationsFor(active.userId, jarId), "contribution_recorded"), "active member").toHaveLength(1);
    expect(ofType(await notificationsFor(left.userId, jarId), "contribution_recorded"), "member who left").toHaveLength(0);
    expect(ofType(await notificationsFor(removed.userId, jarId), "contribution_recorded"), "removed member").toHaveLength(0);
    expect(await notificationsFor(stranger.userId, jarId), "non-member").toHaveLength(0);
  });

  it("removed and left members receive no progress or milestone activity", async () => {
    const owner = await register("shown");
    const removed = await register("shrem");
    const jarId = await createLaunchedJar(owner.token, "SharedActivity", 100_000);
    const removedMemberId = await addActiveMember(jarId, removed.userId);
    await db.update(jarMembers).set({ status: "removed" }).where(eq(jarMembers.id, removedMemberId));

    const ownerMemberId = await memberIdFor(jarId, owner.userId);
    const milestoneId = await createMilestone(jarId, "Shared", 50_000);
    await seedMilestoneFundedLot(jarId, ownerMemberId, milestoneId, 100_000);

    await notifyJarProgressThresholds(jarId);
    await notifyMilestonesFunded(jarId);

    expect(await notificationsFor(removed.userId, jarId)).toHaveLength(0);
    expect(ofType(await notificationsFor(owner.userId, jarId), "goal_fully_funded")).toHaveLength(1);
  });

  it("the contributor's own message describes only their own payment", async () => {
    const owner = await register("selfown");
    const other = await register("selfoth");
    const jarId = await createLaunchedJar(owner.token, "SelfMessage", 10_000_000);
    await addActiveMember(jarId, other.userId);

    const ownerMemberId = await memberIdFor(jarId, owner.userId);
    const { ftId } = await seedSettledLot(jarId, ownerMemberId, 12_345);
    await notifySettledContribution(ftId);

    const mine = ofType(await notificationsFor(owner.userId, jarId), "contribution_recorded")[0]!;
    const theirs = ofType(await notificationsFor(other.userId, jarId), "contribution_recorded")[0]!;

    expect(mine.message).toContain("Your");
    expect(mine.message).toContain("$123.45");
    expect(theirs.message).toContain("$123.45");
    expect(theirs.message).not.toContain("Your ");
  });
});

describe("private financial fields never enter customer-visible content", () => {
  it("no notification exposes provider ids, ledger ids, or member ids", async () => {
    const owner = await register("privown");
    const other = await register("privoth");
    const jarId = await createLaunchedJar(owner.token, "Privacy", 100_000);
    await addActiveMember(jarId, other.userId);
    const ownerMemberId = await memberIdFor(jarId, owner.userId);

    const milestoneId = await createMilestone(jarId, "Private", 50_000);
    const ftId = await seedMilestoneFundedLot(jarId, ownerMemberId, milestoneId, 100_000);
    await notifySettledContribution(ftId);
    await notifyJarProgressThresholds(jarId);
    await notifyMilestonesFunded(jarId);

    const [ft] = await db
      .select({
        id: financialTransactions.id,
        providerTransactionId: financialTransactions.providerTransactionId,
        ledgerId: financialTransactions.ledgerId,
        memberId: financialTransactions.memberId,
      })
      .from(financialTransactions)
      .where(eq(financialTransactions.id, ftId));

    const secrets = [ft!.id, ft!.providerTransactionId, ft!.ledgerId, ft!.memberId, ownerMemberId, milestoneId]
      .filter((v): v is string => typeof v === "string" && v.length > 0);

    const all = [
      ...(await notificationsFor(owner.userId, jarId)),
      ...(await notificationsFor(other.userId, jarId)),
    ];
    expect(all.length).toBeGreaterThan(0);

    for (const row of all) {
      const text = `${row.title} ${row.message}`;
      for (const secret of secrets) {
        expect(text, `notification leaked ${secret}`).not.toContain(secret);
      }
      expect(text).not.toMatch(/\bpi_[A-Za-z0-9_]+/);
      expect(text).not.toMatch(/\bcus_[A-Za-z0-9_]+/);
      expect(text).not.toMatch(/\bre_[A-Za-z0-9_]+/);
      expect(text).not.toMatch(/\b(?:CTRB_REFUNDABLE|CTRB_COMMITTED|EXT_PAY_CLR|DJ_FEE_REVENUE|PROC_FEE_CLR|REFUND_CLR|REFUND_PENDING)\b/);
      expect(text).not.toMatch(/card|bank|last4|\*{4}|declined|issuing/i);
    }
  });

  it("a declined card's provider error never reaches a notification", async () => {
    const owner = await register("declmsg");
    const jarId = await createLaunchedJar(owner.token, "Declined", 100_000);
    const ft = await createUnsettledFt(owner.token, jarId, 50_000);

    await sendWebhook(buildFailedEvent(ft));

    const all = await notificationsFor(owner.userId, jarId);
    for (const row of all) {
      expect(`${row.title} ${row.message}`).not.toContain("declined by the issuing bank");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Reads never write
// ─────────────────────────────────────────────────────────────────────────────

describe("read operations never create notifications", () => {
  it("list, dashboard, jar, and history reads leave the count unchanged", async () => {
    const owner = await register("reads");
    const jarId = await createLaunchedJar(owner.token, "Reads", 100_000);
    const memberId = await memberIdFor(jarId, owner.userId);
    await seedSettledLot(jarId, memberId, 60_000);
    await notifyJarProgressThresholds(jarId);

    const before = (await notificationsFor(owner.userId)).length;
    expect(before).toBeGreaterThan(0);

    const auth = { Authorization: `Bearer ${owner.token}` };
    for (let i = 0; i < 3; i++) {
      await request(app).get(`${BASE}/notifications`).set(auth);
      await request(app).get(`${BASE}/notifications?unreadOnly=true`).set(auth);
      await request(app).get(`${BASE}/dashboard`).set(auth);
      await request(app).get(`${BASE}/jars`).set(auth);
      await request(app).get(`${BASE}/jars/${jarId}`).set(auth);
      await request(app).get(`${BASE}/jars/${jarId}/contributions`).set(auth);
      await request(app).get(`${BASE}/jars/${jarId}/milestones`).set(auth);
    }

    expect((await notificationsFor(owner.userId)).length).toBe(before);
  });

  it("marking notifications read does not create any", async () => {
    const owner = await register("mread");
    const jarId = await createLaunchedJar(owner.token, "MarkRead", 100_000);
    const memberId = await memberIdFor(jarId, owner.userId);
    await seedSettledLot(jarId, memberId, 60_000);
    await notifyJarProgressThresholds(jarId);

    const before = (await notificationsFor(owner.userId)).length;
    const auth = { Authorization: `Bearer ${owner.token}` };
    await request(app).post(`${BASE}/notifications/read-all`).set(auth);
    await request(app).post(`${BASE}/notifications/read-all`).set(auth);

    expect((await notificationsFor(owner.userId)).length).toBe(before);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test Mode route no longer announces settled money
// ─────────────────────────────────────────────────────────────────────────────

describe("the Test Mode contribution route announces nothing to other members", () => {
  it("a simulated contribution creates no contribution notification for anyone", async () => {
    const owner = await register("tmown");
    const other = await register("tmoth");
    const jarId = await createLaunchedJar(owner.token, "TestModeRoute", 10_000_000);
    await addActiveMember(jarId, other.userId);
    await acceptAgreement(jarId, owner.token);

    // Must be a real 201. A 409 `AgreementRequired` would make the assertions
    // below vacuously true — the route would never have run.
    const res = await request(app)
      .post(`${BASE}/jars/${jarId}/contributions`)
      .set("Authorization", `Bearer ${owner.token}`)
      .send({ amountCents: 727_400 });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.status).toBe("simulated");

    expect(ofType(await notificationsFor(other.userId, jarId), "contribution_recorded")).toHaveLength(0);
    expect(ofType(await notificationsFor(owner.userId, jarId), "contribution_recorded")).toHaveLength(0);
    // Nothing at all reached the other member: no type, no amount, no mention.
    const otherAll = await notificationsFor(other.userId, jarId);
    expect(otherAll.filter((n) => n.message.includes("7,274") || n.message.includes("727400"))).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Unimplemented types — asserted as absent, so a future phase must be deliberate
// ─────────────────────────────────────────────────────────────────────────────

describe("refund and commitment notifications are not fabricated", () => {
  it("requesting a refund creates no refund notification", async () => {
    const owner = await register("refnot");
    const jarId = await createLaunchedJar(owner.token, "RefundNone", 1_000_000);
    const memberId = await memberIdFor(jarId, owner.userId);
    await seedSettledLot(jarId, memberId, 50_000);

    const before = (await notificationsFor(owner.userId, jarId)).length;
    const res = await request(app)
      .post(`${BASE}/jars/${jarId}/refunds`)
      .set("Authorization", `Bearer ${owner.token}`)
      .send({ amountCents: 10_000 });
    expect(res.status, JSON.stringify(res.body)).toBe(201);

    // No refund notification type exists yet. This asserts the documented
    // gap rather than a behaviour, so implementing it must update this test.
    const after = await notificationsFor(owner.userId, jarId);
    expect(after.length).toBe(before);
  });
});
