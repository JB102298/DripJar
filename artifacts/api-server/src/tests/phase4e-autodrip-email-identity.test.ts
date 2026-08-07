/**
 * Phase 4E — AutoDrip email identity regression tests
 *
 * Regression guard for a bug where the AutoDrip notification paths selected
 * `profiles.userId` under the alias `displayName`:
 *
 *     .select({ displayName: profiles.userId })   // ← wrong: yields a UUID
 *
 * Drizzle happily aliases any column to any key, so this type-checked and ran
 * fine — but every AutoDrip email greeted the member with their raw user UUID
 * ("Hi 3f2b9c1e-…") instead of their real profile display name.
 *
 * These tests assert the *rendered identity* is the profile displayName and is
 * never the user UUID, for both AutoDrip email paths.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { db } from "@workspace/db";
import {
  users, profiles, jars, jarMembers,
  savedPaymentMethods, autoDripAuthorizations,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import app from "../app.js";
import { notifyAutoDripSucceeded, notifyAutoDripNeedsAttention } from "../routes/autodrip.js";

// ─── Mocks ────────────────────────────────────────────────────────────────────
// Capture the exact options each email helper is invoked with.

const sendSucceeded = vi.fn().mockResolvedValue(true);
const sendNeedsAttention = vi.fn().mockResolvedValue(true);

vi.mock("../lib/autodrip-email.js", () => ({
  sendAutoDripSucceededEmail: (opts: unknown) => sendSucceeded(opts),
  sendAutoDripNeedsAttentionEmail: (opts: unknown) => sendNeedsAttention(opts),
}));

// Only createNotification is stubbed — the notifiers fire it with `void`, and an
// unawaited insert could otherwise land after afterAll() has removed the jar.
// Other exports (notifyAllMembers) stay real so unrelated routes are unaffected.
vi.mock("../lib/notifications.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/notifications.js")>()),
  createNotification: vi.fn().mockResolvedValue(undefined),
}));

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const TS = Date.now();
const MEMBER_EMAIL = `ad-identity-${TS}@dripjar.test`;
const FIRST_NAME = "Ada";
const LAST_NAME = "Lovelace";
/** register() builds displayName as `${firstName} ${lastName}`.trim() */
const EXPECTED_DISPLAY_NAME = `${FIRST_NAME} ${LAST_NAME}`;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let userId: string;
let jarId: string;
let memberId: string;
let pmId: string;
let authRow: typeof autoDripAuthorizations.$inferSelect;

beforeAll(async () => {
  const reg = await request(app)
    .post("/api/auth/register")
    .send({ email: MEMBER_EMAIL, password: "Pass1234!", firstName: FIRST_NAME, lastName: LAST_NAME });
  if (reg.status !== 201) {
    throw new Error(`Register failed: ${reg.status} ${JSON.stringify(reg.body)}`);
  }

  const [u] = await db.select({ id: users.id }).from(users).where(eq(users.email, MEMBER_EMAIL));
  userId = u!.id;

  const [jar] = await db.insert(jars).values({
    organizerId: userId,
    name: "AutoDrip Identity Jar",
    slug: `ad-identity-${TS}`,
    targetDate: "2027-12-31",
    goalAmountCents: 100000,
    timeZone: "America/New_York",
  }).returning();
  jarId = jar!.id;

  const [mem] = await db.insert(jarMembers).values({
    jarId, userId, status: "active", role: "member",
  }).returning();
  memberId = mem!.id;

  await db.update(profiles)
    .set({ stripeCustomerId: `cus_ad_identity_${TS}` })
    .where(eq(profiles.userId, userId));

  const [pm] = await db.insert(savedPaymentMethods).values({
    userId,
    stripeCustomerId: `cus_ad_identity_${TS}`,
    stripePaymentMethodId: `pm_ad_identity_${TS}`,
    type: "card", last4: "4242", isDefault: true, status: "active",
  }).returning();
  pmId = pm!.id;

  const [auth] = await db.insert(autoDripAuthorizations).values({
    jarId, memberId, userId,
    savedPaymentMethodId: pmId,
    principalCents: 50000,
    frequency: "monthly",
    status: "active",
    nextRunAt: new Date("2027-01-01T12:00:00Z"),
  }).returning();
  authRow = auth!;
});

afterAll(async () => {
  await db.delete(autoDripAuthorizations).where(eq(autoDripAuthorizations.jarId, jarId));
  await db.delete(savedPaymentMethods).where(eq(savedPaymentMethods.userId, userId));
  await db.delete(jarMembers).where(eq(jarMembers.jarId, jarId));
  await db.delete(jars).where(eq(jars.id, jarId));
});

// ─── Sanity: the fixture actually has a distinct displayName ─────────────────

describe("AutoDrip email identity — fixture sanity", () => {
  it("profile displayName is a real name, distinct from the user UUID", async () => {
    const [p] = await db
      .select({ displayName: profiles.displayName })
      .from(profiles)
      .where(eq(profiles.userId, userId));

    expect(p?.displayName).toBe(EXPECTED_DISPLAY_NAME);
    expect(p?.displayName).not.toBe(userId);
    expect(userId).toMatch(UUID_RE);
  });
});

// ─── Behavioural regression tests ─────────────────────────────────────────────

describe("notifyAutoDripSucceeded", () => {
  it("sends the succeeded email using the profile displayName, not the user UUID", async () => {
    sendSucceeded.mockClear();

    await notifyAutoDripSucceeded({
      userId,
      jarId,
      principalCents: 50000,
      frequency: "monthly",
    });

    expect(sendSucceeded).toHaveBeenCalledTimes(1);
    const opts = sendSucceeded.mock.calls[0]![0] as { displayName: string; toEmail: string; jarName: string };

    expect(opts.displayName).toBe(EXPECTED_DISPLAY_NAME);
    // The actual regression: displayName must never be the raw user UUID.
    expect(opts.displayName).not.toBe(userId);
    expect(opts.displayName).not.toMatch(UUID_RE);
    expect(opts.toEmail).toBe(MEMBER_EMAIL);
    expect(opts.jarName).toBe("AutoDrip Identity Jar");
  });
});

describe("notifyAutoDripNeedsAttention", () => {
  it("sends the needs-attention email using the profile displayName, not the user UUID", async () => {
    sendNeedsAttention.mockClear();

    await notifyAutoDripNeedsAttention(authRow, "Your card was declined");

    expect(sendNeedsAttention).toHaveBeenCalledTimes(1);
    const opts = sendNeedsAttention.mock.calls[0]![0] as {
      displayName: string; toEmail: string; jarName: string; reason: string;
    };

    expect(opts.displayName).toBe(EXPECTED_DISPLAY_NAME);
    expect(opts.displayName).not.toBe(userId);
    expect(opts.displayName).not.toMatch(UUID_RE);
    expect(opts.toEmail).toBe(MEMBER_EMAIL);
    expect(opts.reason).toBe("Your card was declined");
  });
});

// ─── Static guard ─────────────────────────────────────────────────────────────
//
// The Stripe webhook failure path builds the same email inline via a dynamic
// import, which makes it awkward to drive from a unit test. A source-level guard
// covers every AutoDrip email path — including that one — against the exact
// aliasing mistake that caused this bug.

describe("AutoDrip email identity — static guard", () => {
  const SOURCES = [
    "src/routes/autodrip.ts",
    "src/routes/stripe-webhooks.ts",
  ];

  it.each(SOURCES)("%s never aliases an identifier column to displayName", (relPath) => {
    const source = readFileSync(join(__dirname, "..", "..", relPath), "utf8");

    // e.g. `displayName: profiles.userId`, `displayName: users.id`
    const badAlias = /displayName\s*:\s*(?:profiles|users|jarMembers)\.(?:userId|id)\b/g;
    const matches = source.match(badAlias) ?? [];

    expect(
      matches,
      `${relPath} aliases an identifier column to displayName: ${matches.join(", ")}`,
    ).toEqual([]);
  });
});
