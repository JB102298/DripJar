/**
 * DripJar Seed Script
 * Creates realistic demo data: Jordan Barrett's Hawaii 2027 jar
 * Run: pnpm --filter @workspace/scripts run seed
 */
import { db } from "@workspace/db";
import {
  users,
  profiles,
  jars,
  jarMembers,
  contributions,
  milestones,
  agreements,
  agreementAcceptances,
  activityEvents,
  notifications,
  invitations,
} from "@workspace/db";
import { purgeSyntheticAccounts } from "../../artifacts/api-server/src/lib/owner-reset.js";
import bcrypt from "bcryptjs";

const PASSWORD = "password123";
const HASH = await bcrypt.hash(PASSWORD, 10);

// ─── Dates ─────────────────────────────────────────────────────────────────
const now = new Date();
const launchedAt = new Date(now);
launchedAt.setDate(launchedAt.getDate() - 60);

const targetDate = new Date(now);
targetDate.setDate(targetDate.getDate() + 108);
const targetDateStr = targetDate.toISOString().split("T")[0]!;

const startDate = new Date(now);
startDate.setDate(startDate.getDate() + 108);
const endDate = new Date(startDate);
endDate.setDate(endDate.getDate() + 10);

function daysAgo(n: number): string {
  const d = new Date(now);
  d.setDate(d.getDate() - n);
  return d.toISOString().split("T")[0]!;
}

// ─── Clear existing seed data ──────────────────────────────────────────────

/** The accounts this seed owns, and the only ones its cleanup may remove. */
export const SEED_EMAILS = [
  "jordan@dripjar.dev",
  "demo@dripjar.dev",
  "caitlyn@dripjar.dev",
  "mom@dripjar.dev",
  "dad@dripjar.dev",
  "tyler@dripjar.dev",
] as const;

/**
 * Remove the previous seed run.
 *
 * This used to be `db.delete(users)` with the comment "cascade deletes will
 * handle related records". They do not — `jars.organizer_id`,
 * `jar_members.user_id`, `activity_events.user_id`, and
 * `agreement_acceptances.user_id` are all NO ACTION, so a second `pnpm seed`
 * against an already-seeded database raised a foreign-key violation. The seed
 * was single-use and nobody noticed because it was only ever run on an empty
 * database.
 *
 * It now delegates to `purgeSyntheticAccounts`, which walks the same ordered
 * delete plan the owner reset uses. One delete order, derived from the live
 * foreign-key graph, rather than two that can disagree. That helper carries the
 * production, non-local-host, unknown-database, and allowlist guards, so the
 * seed inherits them rather than reimplementing them.
 */
async function clearSeedData() {
  await purgeSyntheticAccounts(SEED_EMAILS);
  console.log("Cleared existing seed data");
}

// ─── Create Users ──────────────────────────────────────────────────────────
async function createUser(data: {
  email: string;
  firstName: string;
  lastName: string;
  displayName?: string;
}) {
  const [user] = await db
    .insert(users)
    .values({
      email: data.email,
      passwordHash: HASH,
      emailVerified: true,
      lastLoginAt: new Date(),
    })
    .returning();

  if (!user) throw new Error(`Failed to create user ${data.email}`);

  const [profile] = await db
    .insert(profiles)
    .values({
      userId: user.id,
      firstName: data.firstName,
      lastName: data.lastName,
      displayName: data.displayName ?? `${data.firstName} ${data.lastName}`,
      timeZone: "America/New_York",
      defaultCurrency: "USD",
    })
    .returning();

  if (!profile) throw new Error(`Failed to create profile for ${data.email}`);

  return { user, profile };
}

async function main() {
  console.log("🌱 Seeding DripJar demo data...\n");

  await clearSeedData();

  // ── Create Users ────────────────────────────────────────────────────────
  //
  // OWNER vs DEMO.
  //
  // `jordan@dripjar.dev` is the owner QA account. It is deliberately created
  // BARE — verified, with a profile, and owning nothing. Owner QA is about what
  // a brand-new account sees, and that walkthrough is impossible if signing in
  // lands on somebody else's half-funded holiday.
  //
  // The rich demonstration fixtures below (Hawaii 2027 and its five members,
  // milestones, and contributions) hang off `demo@dripjar.dev` instead, so they
  // remain available for development and screenshots without being in the
  // owner's way. Nothing in the test suite depends on either account's
  // persisted rows — every test builds the data it asserts on.
  const { user: jordan } = await createUser({
    email: "jordan@dripjar.dev",
    firstName: "Jordan",
    lastName: "Barrett",
  });
  const { user: demo } = await createUser({
    email: "demo@dripjar.dev",
    firstName: "Demo",
    lastName: "Organizer",
    displayName: "Demo Organizer",
  });
  const { user: caitlyn } = await createUser({
    email: "caitlyn@dripjar.dev",
    firstName: "Caitlyn",
    lastName: "Brooks",
  });
  const { user: mary } = await createUser({
    email: "mom@dripjar.dev",
    firstName: "Mary",
    lastName: "Barrett",
    displayName: "Mom",
  });
  const { user: robert } = await createUser({
    email: "dad@dripjar.dev",
    firstName: "Robert",
    lastName: "Barrett",
    displayName: "Dad",
  });
  const { user: tyler } = await createUser({
    email: "tyler@dripjar.dev",
    firstName: "Tyler",
    lastName: "Barrett",
    displayName: "Brother",
  });

  console.log("✓ Created 6 users (owner jordan@dripjar.dev intentionally has no jars)");

  // ── Create Hawaii 2027 Jar ───────────────────────────────────────────────
  const [hawaiiJar] = await db
    .insert(jars)
    .values({
      organizerId: demo.id,
      name: "Hawaii 2027",
      slug: "hawaii-2027-demo",
      category: "Vacation",
      description:
        "A dream family vacation to Maui, Hawaii! We've been planning this for years — let's make it happen together.",
      destination: "Maui, Hawaii",
      coverImageUrl: null, // Will use local asset
      startDate: startDate.toISOString().split("T")[0]!,
      endDate: endDate.toISOString().split("T")[0]!,
      targetDate: targetDateStr,
      goalAmountCents: 1_000_000, // $10,000
      currency: "USD",
      status: "Saving",
      approvalThreshold: "0.670",
      launchedAt,
    })
    .returning();

  if (!hawaiiJar) throw new Error("Failed to create Hawaii jar");
  console.log("✓ Created Hawaii 2027 jar");

  // ── Create Jar Members ───────────────────────────────────────────────────
  const memberTargets = [
    { user: demo, role: "organizer" as const, targetCents: 220_000 },   // $2,200
    { user: caitlyn, role: "member" as const, targetCents: 200_000 },  // $2,000
    { user: mary, role: "member" as const, targetCents: 180_000 },     // $1,800
    { user: robert, role: "member" as const, targetCents: 220_000 },   // $2,200
    { user: tyler, role: "member" as const, targetCents: 180_000 },    // $1,800
  ];

  const memberRecords: Array<typeof jarMembers.$inferSelect> = [];
  for (const mt of memberTargets) {
    const [member] = await db
      .insert(jarMembers)
      .values({
        jarId: hawaiiJar.id,
        userId: mt.user.id,
        role: mt.role,
        contributionTargetCents: mt.targetCents,
        status: "active",
        joinedAt: launchedAt,
      })
      .returning();
    if (!member) throw new Error(`Failed to create member for ${mt.user.id}`);
    memberRecords.push(member);
  }

  const [demoMember, caitlynMember, maryMember, robertMember, tylerMember] = memberRecords as [
    typeof jarMembers.$inferSelect,
    typeof jarMembers.$inferSelect,
    typeof jarMembers.$inferSelect,
    typeof jarMembers.$inferSelect,
    typeof jarMembers.$inferSelect,
  ];

  console.log("✓ Created 5 jar members");

  // ── Create Milestones ────────────────────────────────────────────────────
  const milestoneData = [
    { name: "Flights", targetAmountCents: 250_000, priority: 1, status: "funded" },
    { name: "Lodging", targetAmountCents: 400_000, priority: 2, status: "pending" },
    { name: "Activities", targetAmountCents: 150_000, priority: 3, status: "pending" },
    { name: "Food & Dining", targetAmountCents: 100_000, priority: 4, status: "pending" },
    { name: "Emergency Buffer", targetAmountCents: 100_000, priority: 5, status: "pending" },
  ];

  const milestoneRecords: Array<typeof milestones.$inferSelect> = [];
  for (const ms of milestoneData) {
    const [milestone] = await db
      .insert(milestones)
      .values({
        jarId: hawaiiJar.id,
        name: ms.name,
        targetAmountCents: ms.targetAmountCents,
        dueDate: targetDateStr,
        priority: ms.priority,
        status: ms.status,
      })
      .returning();
    if (!milestone) throw new Error(`Failed to create milestone ${ms.name}`);
    milestoneRecords.push(milestone);
  }

  const [flightsMilestone, lodgingMilestone, activitiesMilestone, foodMilestone, emergencyMilestone] = milestoneRecords as [
    typeof milestones.$inferSelect,
    typeof milestones.$inferSelect,
    typeof milestones.$inferSelect,
    typeof milestones.$inferSelect,
    typeof milestones.$inferSelect,
  ];

  console.log("✓ Created 5 milestones");

  // ── Create Contributions ─────────────────────────────────────────────────
  // Jordan: $1,800 total ($220,000 target = 81.8%)
  // Flights: $500, Lodging: $504, Activities: $200, Food: $140, Emergency: $200, Unallocated: $256
  const demoContribs = [
    { amountCents: 50_000, daysAgoN: 55, milestoneId: flightsMilestone.id, note: "First payment toward flights!" },
    { amountCents: 50_400, daysAgoN: 45, milestoneId: lodgingMilestone.id },
    { amountCents: 36_000, daysAgoN: 35, milestoneId: null },
    { amountCents: 20_000, daysAgoN: 25, milestoneId: activitiesMilestone.id },
    { amountCents: 14_000, daysAgoN: 15, milestoneId: foodMilestone.id },
    { amountCents: 20_000, daysAgoN: 5, milestoneId: emergencyMilestone.id },
  ];

  // Caitlyn: $1,520 total (76%)
  // Flights: $400, Lodging: $504, Activities: $200, Food: $140, Unallocated: $276
  const caitlynContribs = [
    { amountCents: 40_000, daysAgoN: 52, milestoneId: flightsMilestone.id },
    { amountCents: 50_400, daysAgoN: 42, milestoneId: lodgingMilestone.id },
    { amountCents: 20_000, daysAgoN: 28, milestoneId: activitiesMilestone.id },
    { amountCents: 14_000, daysAgoN: 14, milestoneId: foodMilestone.id },
    { amountCents: 27_600, daysAgoN: 3, milestoneId: null },
  ];

  // Mary (Mom): $1,200 total (66.7%)
  // Flights: $300, Lodging: $420, Unallocated: $480
  const maryContribs = [
    { amountCents: 30_000, daysAgoN: 50, milestoneId: flightsMilestone.id },
    { amountCents: 42_000, daysAgoN: 38, milestoneId: lodgingMilestone.id },
    { amountCents: 48_000, daysAgoN: 20, milestoneId: null },
  ];

  // Robert (Dad): $1,750 total (79.5%)
  // Flights: $700, Lodging: $840, Activities: $130, Unallocated: $80
  const robertContribs = [
    { amountCents: 70_000, daysAgoN: 58, milestoneId: flightsMilestone.id, note: "Covered most of the flights" },
    { amountCents: 84_000, daysAgoN: 44, milestoneId: lodgingMilestone.id },
    { amountCents: 13_000, daysAgoN: 30, milestoneId: activitiesMilestone.id },
    { amountCents: 8_000, daysAgoN: 10, milestoneId: null },
  ];

  // Tyler (Brother): $900 total (50%)
  // Flights: $600, Unallocated: $300
  const tylerContribs = [
    { amountCents: 60_000, daysAgoN: 30, milestoneId: flightsMilestone.id },
    { amountCents: 30_000, daysAgoN: 7, milestoneId: null },
  ];

  async function insertContribs(
    memberId: string,
    contribs: Array<{ amountCents: number; daysAgoN: number; milestoneId: string | null; note?: string }>,
  ) {
    for (const c of contribs) {
      await db.insert(contributions).values({
        jarId: hawaiiJar.id,
        memberId,
        amountCents: c.amountCents,
        contributionDate: daysAgo(c.daysAgoN),
        status: "simulated",
        sourceType: "manual",
        milestoneId: c.milestoneId,
        note: c.note ?? null,
      });
    }
  }

  await insertContribs(demoMember.id, demoContribs);
  await insertContribs(caitlynMember.id, caitlynContribs);
  await insertContribs(maryMember.id, maryContribs);
  await insertContribs(robertMember.id, robertContribs);
  await insertContribs(tylerMember.id, tylerContribs);

  console.log("✓ Created contributions (total: ~$7,170 / $10,000)");

  // ── Create Agreement ─────────────────────────────────────────────────────
  const [agreement] = await db
    .insert(agreements)
    .values({
      jarId: hawaiiJar.id,
      version: "1.0",
      content: AGREEMENT_TEXT,
      effectiveDate: launchedAt.toISOString().split("T")[0]!,
    })
    .returning();

  if (!agreement) throw new Error("Failed to create agreement");

  // All members accept the agreement
  for (const userId of [demo.id, caitlyn.id, mary.id, robert.id, tyler.id]) {
    await db.insert(agreementAcceptances).values({
      agreementId: agreement.id,
      userId,
      acceptedAt: launchedAt,
    });
  }

  console.log("✓ Created agreement + 5 acceptances");

  // ── Create Activity Events ───────────────────────────────────────────────
  const activityItems = [
    { userId: demo.id, eventType: "jar_created", description: "Hawaii 2027 was created", daysAgoN: 62, amountCents: null },
    { userId: robert.id, eventType: "contribution_added", description: "Robert added $700.00 toward Flights", daysAgoN: 58, amountCents: 70_000 },
    { userId: demo.id, eventType: "contribution_added", description: "Demo added $500.00 toward Flights", daysAgoN: 55, amountCents: 50_000 },
    { userId: caitlyn.id, eventType: "contribution_added", description: "Caitlyn added $400.00 toward Flights", daysAgoN: 52, amountCents: 40_000 },
    { userId: mary.id, eventType: "contribution_added", description: "Mary added $300.00 toward Flights", daysAgoN: 50, amountCents: 30_000 },
    { userId: null, eventType: "milestone_funded", description: "Flights are fully funded! ($2,500)", daysAgoN: 48, amountCents: 250_000 },
    { userId: caitlyn.id, eventType: "contribution_added", description: "Caitlyn added $504.00 toward Lodging", daysAgoN: 42, amountCents: 50_400 },
    { userId: demo.id, eventType: "contribution_added", description: "Demo added $504.00 toward Lodging", daysAgoN: 45, amountCents: 50_400 },
    { userId: robert.id, eventType: "contribution_added", description: "Robert added $840.00 toward Lodging", daysAgoN: 44, amountCents: 84_000 },
    { userId: mary.id, eventType: "contribution_added", description: "Mary added $420.00 toward Lodging", daysAgoN: 38, amountCents: 42_000 },
    { userId: tyler.id, eventType: "member_joined", description: "Tyler joined the jar", daysAgoN: 35, amountCents: null },
    { userId: tyler.id, eventType: "contribution_added", description: "Tyler added $600.00 toward Flights", daysAgoN: 30, amountCents: 60_000 },
    { userId: demo.id, eventType: "contribution_added", description: "Demo added $200.00 toward Activities", daysAgoN: 25, amountCents: 20_000 },
    { userId: mary.id, eventType: "contribution_added", description: "Mary added $480.00", daysAgoN: 20, amountCents: 48_000 },
    { userId: demo.id, eventType: "contribution_added", description: "Demo added $140.00 toward Food", daysAgoN: 15, amountCents: 14_000 },
    { userId: robert.id, eventType: "contribution_added", description: "Robert added $80.00", daysAgoN: 10, amountCents: 8_000 },
    { userId: tyler.id, eventType: "contribution_added", description: "Tyler added $300.00", daysAgoN: 7, amountCents: 30_000 },
    { userId: demo.id, eventType: "contribution_added", description: "Demo added $200.00 toward Emergency Buffer", daysAgoN: 5, amountCents: 20_000 },
    { userId: caitlyn.id, eventType: "contribution_added", description: "Caitlyn added $276.00", daysAgoN: 3, amountCents: 27_600 },
  ];

  for (const item of activityItems) {
    const createdAt = new Date(now);
    createdAt.setDate(createdAt.getDate() - item.daysAgoN);
    await db.insert(activityEvents).values({
      jarId: hawaiiJar.id,
      userId: item.userId,
      eventType: item.eventType,
      description: item.description,
      amountCents: item.amountCents,
      createdAt,
    });
  }

  console.log("✓ Created 19 activity events");

  // ── Create Notifications for Jordan ─────────────────────────────────────
  const notificationItems = [
    {
      type: "milestone_funded",
      title: "Flights are fully funded!",
      message: "Your group has fully funded the flights milestone. Keep going!",
      isRead: true,
      daysAgoN: 48,
    },
    {
      type: "member_joined",
      title: "Tyler joined Hawaii 2027",
      message: "Tyler Barrett accepted your invitation and joined the jar.",
      isRead: true,
      daysAgoN: 35,
    },
    {
      type: "contribution_recorded",
      title: "New contribution added",
      message: "Caitlyn Brooks added $276.00 to Hawaii 2027.",
      isRead: false,
      daysAgoN: 3,
    },
    {
      type: "contribution_recorded",
      title: "New contribution added",
      message: "Tyler Barrett added $300.00 to Hawaii 2027.",
      isRead: false,
      daysAgoN: 7,
    },
    {
      type: "general",
      title: "Hawaii 2027 is 71% funded!",
      message: "Your group has saved $7,170 of the $10,000 goal. You're making great progress!",
      isRead: false,
      daysAgoN: 1,
    },
  ];

  for (const item of notificationItems) {
    const createdAt = new Date(now);
    createdAt.setDate(createdAt.getDate() - item.daysAgoN);
    await db.insert(notifications).values({
      userId: demo.id,
      type: item.type,
      title: item.title,
      message: item.message,
      isRead: item.isRead,
      relatedJarId: hawaiiJar.id,
      createdAt,
    });
  }

  console.log("✓ Created 5 notifications for Jordan");

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log("\n🎉 Seed complete!\n");
  console.log("Owner QA account — signs in to an EMPTY product state:");
  console.log("  Email:    jordan@dripjar.dev");
  console.log("  Password: password123\n");
  console.log("Demo account — owns Hawaii 2027 and all demonstration fixtures:");
  console.log("  Email:    demo@dripjar.dev");
  console.log("  Password: password123\n");
  console.log("Other accounts (same password):");
  console.log("  caitlyn@dripjar.dev");
  console.log("  mom@dripjar.dev");
  console.log("  dad@dripjar.dev");
  console.log("  tyler@dripjar.dev");
  console.log("\nJar: Hawaii 2027");
  console.log("  Goal: $10,000 | Saved: ~$7,170 (71.7%)");
  console.log(`  Target Date: ${targetDateStr}`);

  process.exit(0);
}

const AGREEMENT_TEXT = `DripJar Savings Agreement — Hawaii 2027

1. SAVING PHASE
All contributions recorded in DripJar during the Saving Phase are simulated transactions. No real money is transferred through this application. This agreement establishes the agreed principles for how the group will manage real funds outside of this platform.

2. REFUND POLICY
During the Saving Phase, any member may withdraw from the jar and request a refund of amounts they have contributed to the group fund, minus any amounts already paid to third-party vendors on behalf of the group.

3. COMMITMENT REQUEST
Before any group funds are designated for a purchase, the Organizer will submit a Commitment Request identifying the amount, purpose, and vendor. Members must review and approve the request per the jar's approval threshold.

4. COMMITTED FUNDS
Once a Commitment Request is approved, the designated amount is considered committed and may not be unilaterally withdrawn by individual members.

5. CANCELLATION
If the jar is cancelled before any Commitment Request is approved, each member retains full control of their contributed funds. The group agrees to manage refunds fairly and promptly.

6. COMMUNICATION
All members agree to communicate openly about any inability to meet their contribution schedule and to give reasonable notice before leaving the jar.

7. DISCLAIMER
This agreement represents the good-faith understanding between group members. It is not a legally binding financial instrument. Consult a financial advisor for advice on group savings arrangements.

By accepting this agreement, you confirm you have read and understood these terms.`;

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
