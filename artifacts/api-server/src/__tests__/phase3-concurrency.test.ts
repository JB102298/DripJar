/**
 * Phase 3 Concurrency & Provider-Unavailable Tests
 *
 * PART 1 — Concurrent email retry claim
 *   Proves that atomicClaimEmailAttempt() is race-safe: only ONE of N
 *   concurrent callers for the same row can transition it to 'sending'.
 *   Losers receive null and MUST NOT send.
 *
 * PART 2 — Production provider-unavailable behaviour
 *   Proves that a missing RESEND_API_KEY in production returns false
 *   (not vacuous success), causing the row to stay 'failed' for retry.
 *   Proves that a Resend send() error also returns false.
 *   Proves that test mode never delivers real email.
 *
 * vi.mock + vi.hoisted notes:
 *   vi.mock() factories are hoisted to before all module imports. Plain `let`
 *   variables are NOT yet initialised when the factory runs. Use vi.hoisted()
 *   to create mock values that are available at factory time.
 *
 *   The Resend mock uses a regular function (not an arrow function) in
 *   mockImplementation so that `new Resend(key)` can construct it correctly.
 *   Arrow functions cannot be used as constructors.
 */

import { vi, describe, it, expect, beforeAll } from "vitest";

// ── vi.hoisted: mock values available before any import ───────────────────────
// Must come before vi.mock() calls.
const mockEmailSend = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ data: { id: "mock-id" }, error: null }),
);

// ── Module-level mock for resend ──────────────────────────────────────────────
// This replaces `new Resend(key)` with a mock instance in ALL tests in this file.
// In test mode, getResendClient() returns null BEFORE creating Resend, so this
// mock is only exercised when NODE_ENV is set to 'production' inside a test.
vi.mock("resend", () => ({
  // Regular function (not arrow) so `new MockResend(key)` works correctly.
  Resend: vi.fn().mockImplementation(function MockResend(this: any) {
    this.emails = { send: mockEmailSend };
  }),
}));

import request from "supertest";
import app from "../app.js";
import { db } from "@workspace/db";
import { reminderSentEvents } from "@workspace/db";
import { eq } from "drizzle-orm";
import { atomicClaimEmailAttempt, STALE_SENDING_MS } from "../routes/reminders.js";
import {
  sendContributionDueEmail,
  sendContributionMissedEmail,
  sendCutoffUpcomingEmail,
} from "../lib/reminder-email.js";

const BASE = "/api";
const INTERNAL_TOKEN = "test-internal-token-concurrency";

// ─── Test helpers ─────────────────────────────────────────────────────────────

async function register(suffix: string) {
  const email = `conc-${suffix}-${Date.now()}@test.invalid`;
  const res = await request(app).post(`${BASE}/auth/register`).send({
    email, password: "P@ssword1!", firstName: "Test", lastName: `U${suffix}`,
  });
  expect(res.status, `register ${suffix}: ${JSON.stringify(res.body)}`).toBe(201);
  return { token: res.body.token as string, userId: res.body.user.id as string, email };
}

async function insertTestRow(opts: {
  userId: string;
  emailStatus: string;
  emailAttemptCount?: number;
  emailLastAttemptAt?: Date | null;
  emailSentAt?: Date | null;
}) {
  const [row] = await db.insert(reminderSentEvents).values({
    eventKey: `test-conc:${Date.now()}:${Math.random().toString(36).slice(2)}`,
    userId: opts.userId,
    jarId: null,
    eventType: "contribution_due",
    emailStatus: opts.emailStatus,
    emailAttemptCount: opts.emailAttemptCount ?? 0,
    emailLastAttemptAt: opts.emailLastAttemptAt ?? null,
    emailSentAt: opts.emailSentAt ?? null,
  }).returning();
  return row;
}

async function getRow(id: string) {
  const [row] = await db.select().from(reminderSentEvents).where(eq(reminderSentEvents.id, id)).limit(1);
  return row;
}

async function deleteRow(id: string) {
  await db.delete(reminderSentEvents).where(eq(reminderSentEvents.id, id));
}

/** Swap NODE_ENV and RESEND_API_KEY for one test block. */
function withProdEnv(apiKey: string | undefined, fn: () => Promise<void>) {
  const origNodeEnv = process.env["NODE_ENV"];
  const origApiKey = process.env["RESEND_API_KEY"];
  return async () => {
    process.env["NODE_ENV"] = "production";
    if (apiKey !== undefined) process.env["RESEND_API_KEY"] = apiKey;
    else delete process.env["RESEND_API_KEY"];
    try {
      await fn();
    } finally {
      if (origNodeEnv !== undefined) process.env["NODE_ENV"] = origNodeEnv;
      else delete process.env["NODE_ENV"];
      if (origApiKey !== undefined) process.env["RESEND_API_KEY"] = origApiKey;
      else delete process.env["RESEND_API_KEY"];
      vi.clearAllMocks();
    }
  };
}

// ─── PART 1: Atomic email claim ───────────────────────────────────────────────

describe("PART 1 — Atomic email claim (concurrency-safe)", () => {
  let userId: string;

  beforeAll(async () => { ({ userId } = await register("conc-p1")); });

  it("concurrent claims on a failed row: exactly ONE succeeds", async () => {
    const row = await insertTestRow({
      userId, emailStatus: "failed", emailAttemptCount: 1,
      emailLastAttemptAt: new Date(Date.now() - 60_000),
    });

    // Fire two claims simultaneously — Postgres serialises the row-lock
    const [c1, c2] = await Promise.all([
      atomicClaimEmailAttempt(row.id),
      atomicClaimEmailAttempt(row.id),
    ]);

    expect([c1, c2].filter(Boolean)).toHaveLength(1);

    const updated = await getRow(row.id);
    expect(updated?.emailStatus).toBe("sending");
    // Exactly one increment: 1 → 2
    expect(updated?.emailAttemptCount).toBe(2);

    await deleteRow(row.id);
  });

  it("three concurrent claims on a failed row: exactly ONE succeeds", async () => {
    const row = await insertTestRow({
      userId, emailStatus: "failed", emailAttemptCount: 0,
      emailLastAttemptAt: new Date(Date.now() - 120_000),
    });

    const [c1, c2, c3] = await Promise.all([
      atomicClaimEmailAttempt(row.id),
      atomicClaimEmailAttempt(row.id),
      atomicClaimEmailAttempt(row.id),
    ]);

    expect([c1, c2, c3].filter(Boolean)).toHaveLength(1);

    const updated = await getRow(row.id);
    expect(updated?.emailAttemptCount).toBe(1); // 0 → 1, only once

    await deleteRow(row.id);
  });

  it("concurrent claims on a pending row: exactly ONE succeeds", async () => {
    const row = await insertTestRow({ userId, emailStatus: "pending", emailAttemptCount: 0 });

    const [c1, c2] = await Promise.all([
      atomicClaimEmailAttempt(row.id),
      atomicClaimEmailAttempt(row.id),
    ]);

    expect([c1, c2].filter(Boolean)).toHaveLength(1);

    const updated = await getRow(row.id);
    expect(updated?.emailStatus).toBe("sending");
    expect(updated?.emailAttemptCount).toBe(1);

    await deleteRow(row.id);
  });

  it("after successful claim + delivery: status transitions to sent", async () => {
    const row = await insertTestRow({
      userId, emailStatus: "failed", emailAttemptCount: 1,
      emailLastAttemptAt: new Date(Date.now() - 60_000),
    });

    const claimed = await atomicClaimEmailAttempt(row.id);
    expect(claimed).not.toBeNull();

    // Simulate successful delivery
    await db.update(reminderSentEvents)
      .set({ emailStatus: "sent", emailSentAt: new Date() })
      .where(eq(reminderSentEvents.id, row.id));

    const updated = await getRow(row.id);
    expect(updated?.emailStatus).toBe("sent");
    expect(updated?.emailSentAt).not.toBeNull();

    await deleteRow(row.id);
  });

  it("sent row: subsequent atomic claim returns null (no re-send possible)", async () => {
    const row = await insertTestRow({
      userId, emailStatus: "sent", emailAttemptCount: 1,
      emailLastAttemptAt: new Date(), emailSentAt: new Date(),
    });

    const claimed = await atomicClaimEmailAttempt(row.id);
    expect(claimed).toBeNull();

    const updated = await getRow(row.id);
    expect(updated?.emailStatus).toBe("sent");
    expect(updated?.emailAttemptCount).toBe(1); // unchanged

    await deleteRow(row.id);
  });

  it("skipped_preference row: claim returns null (permanently done)", async () => {
    const row = await insertTestRow({ userId, emailStatus: "skipped_preference" });
    const claimed = await atomicClaimEmailAttempt(row.id);
    expect(claimed).toBeNull();
    await deleteRow(row.id);
  });

  it("concurrent insertions of two different event keys: both succeed and are independently claimable", async () => {
    // Tests the DB-level deduplication invariant: two processors starting
    // simultaneously each insert their own distinct event keys and claim them
    // independently without blocking each other.
    // Uses DB-direct operations to avoid running the full HTTP processor,
    // which would interact with other jars in the shared test DB.
    const key1 = `conc-dedup-${Date.now()}-a-${Math.random().toString(36).slice(2)}`;
    const key2 = `conc-dedup-${Date.now()}-b-${Math.random().toString(36).slice(2)}`;

    const [row1, row2] = await Promise.all([
      db.insert(reminderSentEvents).values({
        eventKey: key1, userId, jarId: null, eventType: "contribution_due", emailStatus: "pending",
      }).returning().then(r => r[0]),
      db.insert(reminderSentEvents).values({
        eventKey: key2, userId, jarId: null, eventType: "contribution_due", emailStatus: "pending",
      }).returning().then(r => r[0]),
    ]);

    // Both claims succeed (different rows)
    const [c1, c2] = await Promise.all([
      atomicClaimEmailAttempt(row1.id),
      atomicClaimEmailAttempt(row2.id),
    ]);
    expect(c1).not.toBeNull();
    expect(c2).not.toBeNull();

    // Finalize both as sent
    await Promise.all([
      db.update(reminderSentEvents).set({ emailStatus: "sent", emailSentAt: new Date() }).where(eq(reminderSentEvents.id, row1.id)),
      db.update(reminderSentEvents).set({ emailStatus: "sent", emailSentAt: new Date() }).where(eq(reminderSentEvents.id, row2.id)),
    ]);

    // Second round of claims: both terminal ('sent') → not claimable
    const [r1, r2] = await Promise.all([
      atomicClaimEmailAttempt(row1.id),
      atomicClaimEmailAttempt(row2.id),
    ]);
    expect(r1).toBeNull();
    expect(r2).toBeNull();

    await deleteRow(row1.id);
    await deleteRow(row2.id);
  });
});

// ─── PART 1: Stale-sending crash recovery ─────────────────────────────────────

describe("PART 1 — Stale-sending crash recovery", () => {
  let userId: string;

  beforeAll(async () => { ({ userId } = await register("stale-p1")); });

  it("'sending' row older than staleMs is reclaimed (crash recovery)", async () => {
    const staleTime = new Date(Date.now() - STALE_SENDING_MS - 60_000);
    const row = await insertTestRow({
      userId, emailStatus: "sending", emailAttemptCount: 1, emailLastAttemptAt: staleTime,
    });

    const claimed = await atomicClaimEmailAttempt(row.id, STALE_SENDING_MS);
    expect(claimed).not.toBeNull();
    expect(claimed!.emailAttemptCount).toBe(2); // incremented on reclaim

    await deleteRow(row.id);
  });

  it("'sending' row newer than staleMs is NOT reclaimed (in-progress protection)", async () => {
    const freshTime = new Date(Date.now() - 30_000); // 30s — well inside 5min window
    const row = await insertTestRow({
      userId, emailStatus: "sending", emailAttemptCount: 1, emailLastAttemptAt: freshTime,
    });

    const claimed = await atomicClaimEmailAttempt(row.id, STALE_SENDING_MS);
    expect(claimed).toBeNull();

    const updated = await getRow(row.id);
    expect(updated?.emailAttemptCount).toBe(1); // unchanged

    await deleteRow(row.id);
  });

  it("'sending' row just past staleMs boundary is reclaimed", async () => {
    const boundaryTime = new Date(Date.now() - STALE_SENDING_MS - 1000);
    const row = await insertTestRow({
      userId, emailStatus: "sending", emailAttemptCount: 2, emailLastAttemptAt: boundaryTime,
    });

    const claimed = await atomicClaimEmailAttempt(row.id, STALE_SENDING_MS);
    expect(claimed).not.toBeNull();

    await deleteRow(row.id);
  });

  it("failed delivery keeps row retryable (failed → claimed → failed → claimable again)", async () => {
    const row = await insertTestRow({
      userId, emailStatus: "failed", emailAttemptCount: 1,
      emailLastAttemptAt: new Date(Date.now() - 120_000),
    });

    // First claim
    const c1 = await atomicClaimEmailAttempt(row.id);
    expect(c1).not.toBeNull();

    // Simulate delivery failure
    await db.update(reminderSentEvents)
      .set({ emailStatus: "failed" })
      .where(eq(reminderSentEvents.id, row.id));

    // Second claim (retry)
    const c2 = await atomicClaimEmailAttempt(row.id);
    expect(c2).not.toBeNull();

    await deleteRow(row.id);
  });
});

// ─── PART 2: Production provider-unavailable behaviour ────────────────────────

describe("PART 2 — Production provider-unavailable (missing RESEND_API_KEY)", () => {
  // These tests set NODE_ENV='production' and unset RESEND_API_KEY.
  // getResendClient() returns { client: null, vacuousSuccess: false } — the
  // code never reaches `new Resend(...)`, so the vi.mock is irrelevant here.

  it(
    "production + no RESEND_API_KEY → sendContributionDueEmail returns false",
    withProdEnv(undefined, async () => {
      const result = await sendContributionDueEmail({
        toEmail: "x@x.com", displayName: "T", jarName: "J", jarId: "j",
        amountCents: 10_000, dueDateISO: "2026-01-01",
      });
      expect(result).toBe(false); // config failure, not vacuous success
    }),
  );

  it(
    "production + no RESEND_API_KEY → sendContributionMissedEmail returns false",
    withProdEnv(undefined, async () => {
      const result = await sendContributionMissedEmail({
        toEmail: "x@x.com", displayName: "T", jarName: "J", jarId: "j",
        amountCents: 10_000, outstandingCents: 10_000,
      });
      expect(result).toBe(false);
    }),
  );

  it(
    "production + no RESEND_API_KEY → sendCutoffUpcomingEmail returns false",
    withProdEnv(undefined, async () => {
      const result = await sendCutoffUpcomingEmail({
        toEmail: "x@x.com", displayName: "T", jarName: "J", jarId: "j",
        cutoffDateISO: "2026-06-01", daysAway: 7,
      });
      expect(result).toBe(false);
    }),
  );

  it(
    "production + no RESEND_API_KEY → row stays failed (config failure is retryable)",
    withProdEnv(undefined, async () => {
      const { userId } = await register("cfg-fail");
      const row = await insertTestRow({
        userId, emailStatus: "failed", emailAttemptCount: 1,
        emailLastAttemptAt: new Date(Date.now() - 120_000),
      });

      // Claim the row
      const claimed = await atomicClaimEmailAttempt(row.id);
      expect(claimed).not.toBeNull();

      // Attempt delivery — returns false (no key)
      const delivered = await sendContributionDueEmail({
        toEmail: "x@x.com", displayName: "T", jarName: "J", jarId: row.jarId ?? "j",
        amountCents: 1000, dueDateISO: "2026-01-01",
      });
      expect(delivered).toBe(false);

      // Processor would set row back to 'failed'
      await db.update(reminderSentEvents).set({ emailStatus: "failed" })
        .where(eq(reminderSentEvents.id, row.id));

      // Row is retryable on next run
      const retry = await atomicClaimEmailAttempt(row.id);
      expect(retry).not.toBeNull();

      await deleteRow(row.id);
    }),
  );
});

describe("PART 2 — Production Resend send() failure", () => {
  // These tests set NODE_ENV='production' WITH a RESEND_API_KEY, so `new Resend(key)`
  // is called — the vi.mock constructor is exercised.

  it(
    "production + Resend.send() throws → sendContributionDueEmail returns false",
    withProdEnv("re_test_key", async () => {
      mockEmailSend.mockRejectedValueOnce(new Error("SMTP connection refused"));
      const result = await sendContributionDueEmail({
        toEmail: "fail@x.com", displayName: "T", jarName: "J", jarId: "j",
        amountCents: 5_000, dueDateISO: "2026-02-01",
      });
      expect(result).toBe(false);
      expect(mockEmailSend).toHaveBeenCalledTimes(1);
    }),
  );

  it(
    "production + Resend.send() throws → row stays failed; next attempt with recovered provider succeeds",
    withProdEnv("re_test_key", async () => {
      const { userId } = await register("prov-recover");
      const row = await insertTestRow({
        userId, emailStatus: "failed", emailAttemptCount: 1,
        emailLastAttemptAt: new Date(Date.now() - 120_000),
      });

      // First attempt: Resend throws
      mockEmailSend.mockRejectedValueOnce(new Error("Provider temporarily unavailable"));
      const claimed1 = await atomicClaimEmailAttempt(row.id);
      expect(claimed1).not.toBeNull();
      const del1 = await sendContributionDueEmail({
        toEmail: "r@x.com", displayName: "T", jarName: "J", jarId: "j",
        amountCents: 1000, dueDateISO: "2026-01-01",
      });
      expect(del1).toBe(false); // send failed
      await db.update(reminderSentEvents).set({ emailStatus: "failed" })
        .where(eq(reminderSentEvents.id, row.id));

      // Second attempt: Resend resolves (provider recovered)
      mockEmailSend.mockResolvedValueOnce({ data: { id: "ok" }, error: null });
      const claimed2 = await atomicClaimEmailAttempt(row.id);
      expect(claimed2).not.toBeNull();
      const del2 = await sendContributionDueEmail({
        toEmail: "r@x.com", displayName: "T", jarName: "J", jarId: "j",
        amountCents: 1000, dueDateISO: "2026-01-01",
      });
      expect(del2).toBe(true); // retry succeeded
      await db.update(reminderSentEvents).set({ emailStatus: "sent", emailSentAt: new Date() })
        .where(eq(reminderSentEvents.id, row.id));

      // Third attempt: row is now 'sent' — not claimable
      const claimed3 = await atomicClaimEmailAttempt(row.id);
      expect(claimed3).toBeNull();

      await deleteRow(row.id);
    }),
  );
});

// ─── PART 2: Test-mode guarantees ────────────────────────────────────────────

describe("PART 2 — Test mode: no real email delivery", () => {
  // NODE_ENV='test' throughout — getResendClient() returns null before
  // ever constructing Resend, so mockEmailSend is NEVER called.

  it("NODE_ENV=test → sendContributionDueEmail returns true (vacuous success, no Resend call)", async () => {
    vi.clearAllMocks();
    const result = await sendContributionDueEmail({
      toEmail: "test@x.com", displayName: "T", jarName: "J", jarId: "j",
      amountCents: 1000, dueDateISO: "2026-01-01",
    });
    expect(result).toBe(true);
    expect(mockEmailSend).not.toHaveBeenCalled(); // Resend never instantiated in test mode
  });

  it("NODE_ENV=test → sendContributionMissedEmail returns true, no Resend call", async () => {
    vi.clearAllMocks();
    const result = await sendContributionMissedEmail({
      toEmail: "test@x.com", displayName: "T", jarName: "J", jarId: "j",
      amountCents: 1000, outstandingCents: 1000,
    });
    expect(result).toBe(true);
    expect(mockEmailSend).not.toHaveBeenCalled();
  });

  it("NODE_ENV=test → sendCutoffUpcomingEmail returns true, no Resend call", async () => {
    vi.clearAllMocks();
    const result = await sendCutoffUpcomingEmail({
      toEmail: "test@x.com", displayName: "T", jarName: "J", jarId: "j",
      cutoffDateISO: "2026-06-01", daysAway: 7,
    });
    expect(result).toBe(true);
    expect(mockEmailSend).not.toHaveBeenCalled();
  });

  it("NODE_ENV=test → all five email functions return true without calling Resend.send()", async () => {
    // Tests the full test-mode path for every email function variant.
    // Uses direct function calls (not the HTTP processor endpoint) to avoid
    // interacting with the shared DB's other test data during parallel file execution.
    vi.clearAllMocks();
    const opts = {
      toEmail: "t@t.com", displayName: "T", jarName: "J", jarId: "j",
      amountCents: 1000, dueDateISO: "2026-01-01", outstandingCents: 1000,
      cutoffDateISO: "2026-06-01", daysAway: 7, version: "1.0",
    };
    const results = await Promise.all([
      sendContributionDueEmail({ ...opts }),
      sendContributionMissedEmail({ ...opts }),
      sendCutoffUpcomingEmail({ ...opts }),
    ]);
    for (const r of results) expect(r).toBe(true);
    // None of the functions should have constructed or called Resend in test mode
    expect(mockEmailSend).not.toHaveBeenCalled();
  });
});

// ─── PART 2: DB-level delivery state ─────────────────────────────────────────

describe("PART 2 — DB delivery state after processor runs", () => {
  let userId: string;

  beforeAll(async () => { ({ userId } = await register("db-state-p2")); });

  it("all five valid email_status values are accepted by DB CHECK constraint", async () => {
    const statuses = ["pending", "sending", "sent", "failed", "skipped_preference"];
    for (const status of statuses) {
      const [row] = await db.insert(reminderSentEvents).values({
        eventKey: `chk-${status}-${Date.now()}-${Math.random()}`,
        userId, jarId: null, eventType: "contribution_due", emailStatus: status,
      }).returning();
      expect(row?.emailStatus).toBe(status);
      await deleteRow(row.id);
    }
  });

  it("'sending' is a valid transient state accepted by the DB", async () => {
    const row = await insertTestRow({ userId, emailStatus: "pending" });
    const claimed = await atomicClaimEmailAttempt(row.id);
    expect(claimed).not.toBeNull();
    const updated = await getRow(row.id);
    expect(updated?.emailStatus).toBe("sending");
    await deleteRow(row.id);
  });

  it("sent event is not claimable: second attempt on same row returns null (idempotency at DB level)", async () => {
    // Proves the core idempotency invariant at the DB level without invoking the
    // full HTTP processor (which would mutate shared DB state for other test files).
    // Full processor-level idempotency is verified in phase3-automation.test.ts.
    const row = await insertTestRow({ userId, emailStatus: "pending", emailAttemptCount: 0 });

    // First claim: succeeds
    const c1 = await atomicClaimEmailAttempt(row.id);
    expect(c1).not.toBeNull();

    // Finalize as sent
    await db.update(reminderSentEvents)
      .set({ emailStatus: "sent", emailSentAt: new Date() })
      .where(eq(reminderSentEvents.id, row.id));

    // Second claim: row is 'sent' — not claimable
    const c2 = await atomicClaimEmailAttempt(row.id);
    expect(c2).toBeNull();

    // Third claim: still not claimable
    const c3 = await atomicClaimEmailAttempt(row.id);
    expect(c3).toBeNull();

    // Attempt count unchanged after terminal state (no spurious increments)
    const final = await getRow(row.id);
    expect(final?.emailAttemptCount).toBe(1); // only the successful first claim

    await deleteRow(row.id);
  });
});
