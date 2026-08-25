/**
 * One lifecycle gate for every money-in route.
 *
 * Before this, three routes disagreed about whether a cancelled jar could take
 * new money:
 *
 *   POST /jars/:id/contributions         inlined ["Saving","CommitmentPending"] — refused
 *   POST /jars/:id/drips/payment-intent  selected only `jars.id` — ACCEPTED
 *   POST /finance/quote                  selected only `jars.id` — ACCEPTED
 *
 * The two that accepted are the ones that reach Stripe. AutoDrip's guards were a
 * denylist naming the two terminal phases, so an unrecognised status fell
 * through and could schedule real charges.
 *
 * All four now call `lifecycleAllowsNewContribution` — an allowlist, so it fails
 * closed — and refuse identically with 422 / `JarLifecycle`.
 *
 * The gate must NOT reach settlement. A payment authorized while the jar was
 * active has to post even if the jar is cancelled before the webhook lands;
 * dropping it would lose money that already left the member's card. That is
 * proven behaviourally below, not by reading source.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { db, pool, jars, financialTransactions, ledgerTransactions, ledgerEntries } from "@workspace/db";
import { eq } from "drizzle-orm";

vi.mock("../lib/stripe.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/stripe.js")>();
  return { ...actual, getStripeClient: vi.fn() };
});

// The payment-intent route provisions a Stripe customer first. Stubbed the same
// way the existing webhook suite does, so the test exercises jar lifecycle
// rather than Stripe customer provisioning.
vi.mock("../lib/stripe-customer.ts", () => ({
  getOrCreateStripeCustomer: vi.fn().mockResolvedValue("cus_money_in_gate_mock"),
}));

import { getStripeClient } from "../lib/stripe.js";
import app from "../app.js";
import { purgeSyntheticAccounts } from "../lib/owner-reset.js";
import {
  lifecycleAllowsNewContribution,
  contributionLifecycleMessage,
  JAR_STATUSES,
} from "../lib/jar-status.js";

const BASE = "/api";
const mockGetStripeClient = vi.mocked(getStripeClient);

/**
 * One tag for the whole file, fixed before any fixture is built. Teardown finds
 * fixtures by querying for it, so a setup helper that throws part-way through
 * still leaves rows the cleanup can see.
 */
const FIXTURE_TAG = `mig${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const TAGGED_EMAIL_LIKE = `%-${FIXTURE_TAG}@test.invalid`;
const TAGGED_JAR_LIKE = `%${FIXTURE_TAG}%`;

let uniqCounter = 0;
const uniq = () => `${++uniqCounter}`;

const countRow = async (sql: string, params: unknown[] = []) =>
  Number((await pool.query(sql, params)).rows[0].c);

function mockStripe() {
  return {
    paymentIntents: {
      create: vi.fn().mockImplementation(async () => ({
        id: `pi_gate_${uniq()}_${Date.now()}`,
        status: "requires_confirmation",
        client_secret: "cs_test_gate",
      })),
      retrieve: vi.fn().mockImplementation(async (id: string) => ({
        id,
        status: "requires_confirmation",
        client_secret: "cs_test_gate",
      })),
    },
    // drips.ts mints a customer session alongside the intent; without this the
    // route fails with "Cannot read properties of undefined (reading 'create')"
    // and the settlement test never gets a payment to settle.
    customerSessions: {
      create: vi.fn().mockImplementation(async () => ({
        client_secret: "cuss_test_gate",
      })),
    },
    webhooks: {
      constructEvent: vi.fn((body: Buffer | string) =>
        JSON.parse(typeof body === "string" ? body : body.toString()),
      ),
    },
  } as unknown as ReturnType<typeof getStripeClient>;
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

async function register(suffix: string) {
  const res = await request(app).post(`${BASE}/auth/register`).send({
    email: `money-in-${suffix}${uniq()}-${FIXTURE_TAG}@test.invalid`,
    password: "P@ssword1!",
    firstName: "Money",
    lastName: "Gate",
  });
  expect(res.status, `register ${suffix}: ${JSON.stringify(res.body)}`).toBe(201);
  return { token: res.body.token as string, userId: res.body.user.id as string };
}

/** Jar names carry the tag too, so a jar whose organizer failed is still findable. */
async function createLaunchedJar(token: string) {
  const create = await request(app).post(`${BASE}/jars`).set("Authorization", `Bearer ${token}`).send({
    name: `Gate ${FIXTURE_TAG} ${uniq()}`,
    category: "Vacation",
    goalAmountCents: 500_000,
    targetDate: new Date(Date.now() + 120 * 86_400_000).toISOString().slice(0, 10),
  });
  expect(create.status, `create jar: ${JSON.stringify(create.body)}`).toBe(201);
  const jarId = create.body.id as string;
  const launch = await request(app).post(`${BASE}/jars/${jarId}/launch`).set("Authorization", `Bearer ${token}`);
  expect(launch.status, `launch jar: ${JSON.stringify(launch.body)}`).toBe(200);
  return jarId;
}

const setStatus = (jarId: string, status: string) =>
  db.update(jars).set({ status, updatedAt: new Date() }).where(eq(jars.id, jarId));

/** Statuses that must be refused by every money-in route. */
const REFUSED = ["Draft", "Inviting", "Committed", "FullyFunded", "Cancelled", "Completed"];
/** Values no code writes, but a legacy row or a newer server could hold. */
const UNKNOWN = ["Archived", "Paused", "LEGACY_STATE", "saving", ""];

/** Every money-in route, described once so the tables below stay honest. */
const MONEY_IN_ROUTES = [
  {
    name: "POST /jars/:id/contributions",
    call: (jarId: string, token: string) =>
      request(app)
        .post(`${BASE}/jars/${jarId}/contributions`)
        .set("Authorization", `Bearer ${token}`)
        .send({ amountCents: 5_000 }),
  },
  {
    // A syntactically valid id is required to clear body validation (400) and
    // reach the lifecycle gate. The id need not resolve: the route checks the
    // jar's status before it looks the transaction up, which is the ordering
    // under test — a cancelled jar must be refused before any money work.
    name: "POST /jars/:id/drips/payment-intent",
    call: (jarId: string, token: string) =>
      request(app)
        .post(`${BASE}/jars/${jarId}/drips/payment-intent`)
        .set("Authorization", `Bearer ${token}`)
        .send({ financialTransactionId: randomUUID() }),
  },
  {
    name: "POST /finance/quote",
    call: (jarId: string, token: string) =>
      request(app)
        .post(`${BASE}/finance/quote`)
        .set("Authorization", `Bearer ${token}`)
        .send({ principalCents: 5_000, paymentMethodType: "card", jarId }),
  },
  {
    name: "POST /jars/:id/autodrip",
    call: (jarId: string, token: string) =>
      request(app)
        .post(`${BASE}/jars/${jarId}/autodrip`)
        .set("Authorization", `Bearer ${token}`)
        .send({ principalCents: 5_000, frequency: "monthly", paymentMethodId: "pm_fixture", consentGiven: true }),
  },
] as const;

// ─── Orphan baseline ─────────────────────────────────────────────────────────

const ORPHAN_SQL = {
  ledgerEntries: `select count(*)::int c from ledger_entries le
                    left join ledger_transactions lt on lt.id = le.ledger_transaction_id
                   where lt.id is null`,
  ledgerTransactions: `select count(*)::int c from ledger_transactions lt
                    left join financial_transactions ft on ft.id = lt.financial_transaction_id
                   where ft.id is null`,
  financialTransactions: `select count(*)::int c from financial_transactions ft
                    left join jars j on j.id = ft.jar_id where j.id is null`,
} as const;

let orphanBaseline: Record<string, number>;

/**
 * The webhook secret this suite installs, and whatever was there before it.
 *
 * Other suites in the same worker set their own; clobbering it and then
 * `delete`-ing would silently break them. Captured here, restored exactly.
 */
const TEST_WEBHOOK_SECRET = "whsec_test_money_in_gate";
let priorWebhookSecret: string | undefined;

beforeAll(async () => {
  mockGetStripeClient.mockReturnValue(mockStripe());

  priorWebhookSecret = process.env["STRIPE_WEBHOOK_SECRET"];
  process.env["STRIPE_WEBHOOK_SECRET"] = TEST_WEBHOOK_SECRET;

  // Recorded, not assumed to be zero — this database carries rows from other
  // suites, and this file answers only for its own delta.
  orphanBaseline = {
    ledgerEntries: await countRow(ORPHAN_SQL.ledgerEntries),
    ledgerTransactions: await countRow(ORPHAN_SQL.ledgerTransactions),
    financialTransactions: await countRow(ORPHAN_SQL.financialTransactions),
  };
});

afterAll(async () => {
  // try/finally so the environment and mocks are restored even if the purge
  // throws or an assertion below fails. On the successful path the database
  // work still happens first, which is what the cleanup needs.
  try {
    const tagged = (
      await pool.query(`select email from users where email like $1 order by email`, [TAGGED_EMAIL_LIKE])
    ).rows.map((r) => r.email as string);

    if (tagged.length) {
      await purgeSyntheticAccounts(tagged, { approvedEmails: tagged, quiet: true });
    }

    expect(
      await countRow(`select count(*)::int c from jars where name like $1`, [TAGGED_JAR_LIKE]),
      "tagged jars survived the purge",
    ).toBe(0);
    expect(
      await countRow(`select count(*)::int c from users where email like $1`, [TAGGED_EMAIL_LIKE]),
      "tagged users survived the purge",
    ).toBe(0);

    for (const key of Object.keys(ORPHAN_SQL) as (keyof typeof ORPHAN_SQL)[]) {
      expect(await countRow(ORPHAN_SQL[key]), `${key} orphans increased`).toBe(orphanBaseline[key]);
    }
  } finally {
    if (priorWebhookSecret === undefined) {
      delete process.env["STRIPE_WEBHOOK_SECRET"];
    } else {
      process.env["STRIPE_WEBHOOK_SECRET"] = priorWebhookSecret;
    }
    vi.restoreAllMocks();
  }
});

// ─── The predicate ───────────────────────────────────────────────────────────

describe("lifecycleAllowsNewContribution is an allowlist", () => {
  it("permits exactly Saving and CommitmentPending", () => {
    const allowed = JAR_STATUSES.filter((s) => lifecycleAllowsNewContribution(s));
    expect([...allowed].sort()).toEqual(["CommitmentPending", "Saving"]);
  });

  it.each(REFUSED)("refuses the known non-contributing status %s", (s) => {
    expect(lifecycleAllowsNewContribution(s)).toBe(false);
  });

  it.each(UNKNOWN)("refuses the unrecognised value %p", (s) => {
    expect(lifecycleAllowsNewContribution(s)).toBe(false);
  });

  it("refuses null and undefined rather than throwing", () => {
    expect(lifecycleAllowsNewContribution(null)).toBe(false);
    expect(lifecycleAllowsNewContribution(undefined)).toBe(false);
  });

  it("names the offending status without leaking anything else", () => {
    expect(contributionLifecycleMessage("Cancelled")).toContain("Cancelled");
    expect(contributionLifecycleMessage("")).toContain("unknown");
    expect(contributionLifecycleMessage(null)).toContain("unknown");
  });
});

// ─── Route × status matrix ───────────────────────────────────────────────────

describe("every money-in route refuses every non-contributing status identically", () => {
  let token: string;
  let jarId: string;

  beforeAll(async () => {
    const owner = await register("matrix");
    token = owner.token;
    jarId = await createLaunchedJar(token);
  });

  for (const status of [...REFUSED, ...UNKNOWN]) {
    for (const route of MONEY_IN_ROUTES) {
      it(`${route.name} refuses ${status === "" ? "<empty>" : status}`, async () => {
        await setStatus(jarId, status);
        const r = await route.call(jarId, token);
        expect(r.status, `${route.name} @ "${status}": ${JSON.stringify(r.body)}`).toBe(422);
        expect(r.body.error).toBe("JarLifecycle");
        expect(r.body.message).toMatch(/not accepting contributions/i);
      });
    }
  }
});

describe("an active jar passes the lifecycle gate", () => {
  it.each(["Saving", "CommitmentPending"])("%s is not refused for lifecycle reasons", async (status) => {
    // Necessary, not sufficient: the call may still fail on membership, payment
    // readiness, amount or idempotency. Only the lifecycle verdict is asserted.
    const owner = await register(`act${status}`);
    const jarId = await createLaunchedJar(owner.token);
    await setStatus(jarId, status);

    const r = await MONEY_IN_ROUTES[0].call(jarId, owner.token);
    expect(r.body.error).not.toBe("JarLifecycle");
  });

  it("membership is still required independently of the gate", async () => {
    const owner = await register("mowner");
    const outsider = await register("moutsider");
    const jarId = await createLaunchedJar(owner.token);

    const r = await MONEY_IN_ROUTES[0].call(jarId, outsider.token);
    expect(r.status).toBe(403); // refused for membership …
    expect(r.body.error).not.toBe("JarLifecycle"); // … not for lifecycle
  });
});

// ─── Settlement is never gated (behavioural) ─────────────────────────────────

describe("a payment authorized before cancellation still settles exactly once", () => {
  it("posts the transaction and ledger once, and leaves the principal refundable", async () => {
    const owner = await register("settle");
    const jarId = await createLaunchedJar(owner.token);

    // 1. Authorize while the jar is genuinely active. Both of these routes are
    //    now lifecycle-gated, so reaching an FT at all proves the gate let it
    //    through rather than the check being absent.
    const quote = await request(app)
      .post(`${BASE}/finance/quote`)
      .set("Authorization", `Bearer ${owner.token}`)
      .send({ principalCents: 20_000, paymentMethodType: "card", jarId });
    expect(quote.status, `quote: ${JSON.stringify(quote.body)}`).toBe(200);
    const ftId = quote.body.financialTransactionId as string;
    expect(typeof ftId).toBe("string");

    const pi = await request(app)
      .post(`${BASE}/jars/${jarId}/drips/payment-intent`)
      .set("Authorization", `Bearer ${owner.token}`)
      .send({ financialTransactionId: ftId });
    expect(
      [200, 201],
      `payment-intent must succeed before the webhook can be built: ${JSON.stringify(pi.body)}`,
    ).toContain(pi.status);

    // Re-read: the webhook is keyed on the provider transaction id, so an empty
    // one would make the rest of this test assert against nothing.
    const [before] = await db.select().from(financialTransactions).where(eq(financialTransactions.id, ftId));
    expect(before, "financial transaction should exist after PI creation").toBeTruthy();
    expect(typeof before!.providerTransactionId).toBe("string");
    expect((before!.providerTransactionId ?? "").length).toBeGreaterThan(0);
    expect(before!.ledgerPostingStatus).not.toBe("posted");

    // 2. The organizer cancels while the charge is in flight.
    await setStatus(jarId, "Cancelled");

    // 3. Stripe reports success. This must NOT be dropped.
    const event = {
      id: `evt_gate_${uniq()}_${Date.now()}`,
      type: "payment_intent.succeeded",
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: before!.providerTransactionId,
          object: "payment_intent",
          amount: Number(before!.totalQuotedCents),
          currency: before!.currency.toLowerCase(),
          status: "succeeded",
          latest_charge: null,
          metadata: { financialTransactionId: ftId, jarId, memberId: before!.memberId },
        },
      },
    };
    const send = () =>
      request(app)
        .post(`${BASE}/webhooks/stripe`)
        .set("Content-Type", "application/json")
        .set("stripe-signature", "t=1,v1=stub")
        .send(JSON.stringify(event));

    expect((await send()).status).toBe(200);

    // 4. Posted canonically, exactly once.
    const [after] = await db.select().from(financialTransactions).where(eq(financialTransactions.id, ftId));
    expect(after!.providerStatus).toBe("succeeded");
    expect(after!.ledgerPostingStatus).toBe("posted");

    // The Stripe transaction points AT its ledger posting via `ledger_id`.
    // (`ledger_transactions.financial_transaction_id` names the internal
    // accounting transaction the posting created, not this Stripe one.)
    const ledgerId = after!.ledgerId;
    expect(typeof ledgerId, "settled FT must be linked to a ledger posting").toBe("string");

    const lts = await db.select().from(ledgerTransactions).where(eq(ledgerTransactions.id, ledgerId!));
    expect(lts, "ledger transaction should be created exactly once").toHaveLength(1);

    const entries = await db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.ledgerTransactionId, ledgerId!));
    expect(entries.length).toBeGreaterThan(0);
    const debits = entries.filter((e) => e.entryType === "debit").reduce((s, e) => s + Number(e.amountCents), 0);
    const credits = entries.filter((e) => e.entryType === "credit").reduce((s, e) => s + Number(e.amountCents), 0);
    expect(debits, "ledger must balance").toBe(credits);

    // 5. Redelivery must not double-post: same ledger posting, same entries.
    expect((await send()).status).toBe(200);
    const [afterRedelivery] = await db
      .select()
      .from(financialTransactions)
      .where(eq(financialTransactions.id, ftId));
    expect(afterRedelivery!.ledgerId, "redelivery must not repost to a new ledger transaction").toBe(ledgerId);
    expect(
      await db.select().from(ledgerEntries).where(eq(ledgerEntries.ledgerTransactionId, ledgerId!)),
      "redelivery must not add ledger entries",
    ).toHaveLength(entries.length);

    // 6. The settled principal is ordinary uncommitted money and refundable,
    //    even though the jar is cancelled. This is the whole point.
    const p = await request(app)
      .get(`${BASE}/jars/${jarId}/refunds/preview`)
      .set("Authorization", `Bearer ${owner.token}`);
    expect(p.status, `preview: ${JSON.stringify(p.body)}`).toBe(200);
    expect(p.body.refundableCents).toBe(20_000);
  });
});

// ─── Drift guards (secondary, not the proof) ─────────────────────────────────

describe("drift guards", () => {
  const readRoute = async (f: string) => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    return readFileSync(join(__dirname, "../routes", f), "utf-8");
  };

  it("settlement and refund routes never consult the money-in predicate", async () => {
    expect(await readRoute("stripe-webhooks.ts")).not.toContain("lifecycleAllowsNewContribution");
    expect(await readRoute("refunds.ts")).not.toContain("lifecycleAllowsNewContribution");
  });

  it("no money-in route inlines its own status list", async () => {
    for (const f of ["contributions.ts", "drips.ts", "finance.ts", "autodrip.ts"]) {
      const src = await readRoute(f);
      expect(src, `${f} inlines a status array`).not.toMatch(/\[\s*"Saving"\s*,\s*"CommitmentPending"\s*\]/);
      expect(src, `${f} denylists terminal phases inline`).not.toMatch(
        /===\s*"Cancelled"\s*\|\|\s*\w+\s*===\s*"Completed"/,
      );
    }
  });
});
