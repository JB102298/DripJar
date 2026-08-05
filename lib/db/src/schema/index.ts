import {
  pgTable,
  text,
  integer,
  bigint,
  boolean,
  timestamp,
  numeric,
  uuid,
  date,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

// ─── Users ───────────────────────────────────────────────────────────────────

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull(),
  passwordHash: text("password_hash"),
  emailVerified: boolean("email_verified").notNull().default(false),
  resetTokenHash: text("reset_token_hash"),
  resetTokenExpiresAt: timestamp("reset_token_expires_at"),
  verificationTokenHash: text("verification_token_hash"),
  verificationTokenExpiresAt: timestamp("verification_token_expires_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  lastLoginAt: timestamp("last_login_at"),
}, (t) => [
  uniqueIndex("users_email_idx").on(t.email),
]);

export const usersRelations = relations(users, ({ one, many }) => ({
  profile: one(profiles, { fields: [users.id], references: [profiles.userId] }),
  jarMembers: many(jarMembers),
  notifications: many(notifications),
  activityEvents: many(activityEvents),
  agreementAcceptances: many(agreementAcceptances),
  refreshSessions: many(refreshSessions),
}));

// ─── Refresh Sessions ─────────────────────────────────────────────────────────

export const refreshSessions = pgTable("refresh_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull(),
  userAgent: text("user_agent"),
  ipAddress: text("ip_address"),
  expiresAt: timestamp("expires_at").notNull(),
  revokedAt: timestamp("revoked_at"),
  revokeReason: text("revoke_reason"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  lastUsedAt: timestamp("last_used_at"),
  // Every session belongs to a family.  On login/register a new UUID is minted;
  // on rotation the new session inherits the parent's familyId.
  // Replay detection revokes all active sessions sharing this familyId.
  familyId: uuid("family_id").notNull().defaultRandom(),
}, (t) => [
  uniqueIndex("refresh_sessions_token_hash_idx").on(t.tokenHash),
  index("refresh_sessions_user_id_idx").on(t.userId),
  index("refresh_sessions_family_id_idx").on(t.familyId),
]);

export const refreshSessionsRelations = relations(refreshSessions, ({ one }) => ({
  user: one(users, { fields: [refreshSessions.userId], references: [users.id] }),
}));

// ─── Profiles ────────────────────────────────────────────────────────────────

export const profiles = pgTable("profiles", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  firstName: text("first_name").notNull(),
  lastName: text("last_name").notNull(),
  displayName: text("display_name").notNull(),
  avatarUrl: text("avatar_url"),
  phone: text("phone"),
  timeZone: text("time_zone").notNull().default("America/New_York"),
  defaultCurrency: text("default_currency").notNull().default("USD"),
  // Email notification preferences — defaults to opted-in for transactional
  // product messages. Security emails (password reset, verification) always
  // send regardless of these flags.
  emailPrefContributionReminders: boolean("email_pref_contribution_reminders").notNull().default(true),
  emailPrefCutoffReminders: boolean("email_pref_cutoff_reminders").notNull().default(true),
  emailPrefLifecycle: boolean("email_pref_lifecycle").notNull().default(true),
  // Phase 4B: Stripe Customer ID — null until first Stripe payment is initiated
  stripeCustomerId: text("stripe_customer_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("profiles_user_id_idx").on(t.userId),
  uniqueIndex("profiles_stripe_customer_id_idx").on(t.stripeCustomerId),
]);

export const profilesRelations = relations(profiles, ({ one }) => ({
  user: one(users, { fields: [profiles.userId], references: [users.id] }),
}));

// ─── Jars ─────────────────────────────────────────────────────────────────────

export const jars = pgTable("jars", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizerId: uuid("organizer_id").notNull().references(() => users.id),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  category: text("category").notNull().default("Vacation"),
  description: text("description"),
  destination: text("destination"),
  coverImageUrl: text("cover_image_url"),
  startDate: date("start_date"),
  endDate: date("end_date"),
  targetDate: date("target_date").notNull(),
  // cutoffDate: organizer-set date when the Saving phase ends and the
  // Commitment phase begins. Must be before targetDate. The jar's derived
  // `phase` is "Commitment" when status is "Saving" and today >= cutoffDate.
  cutoffDate: date("cutoff_date"),
  goalAmountCents: integer("goal_amount_cents").notNull(),
  currency: text("currency").notNull().default("USD"),
  status: text("status").notNull().default("Draft"),
  approvalThreshold: numeric("approval_threshold", { precision: 4, scale: 3 }).notNull().default("0.670"),
  launchedAt: timestamp("launched_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("jars_slug_idx").on(t.slug),
  index("jars_organizer_idx").on(t.organizerId),
]);

export const jarsRelations = relations(jars, ({ one, many }) => ({
  organizer: one(users, { fields: [jars.organizerId], references: [users.id] }),
  members: many(jarMembers),
  invitations: many(invitations),
  contributions: many(contributions),
  contributionSchedules: many(contributionSchedules),
  milestones: many(milestones),
  commitmentRequests: many(commitmentRequests),
  agreements: many(agreements),
  activityEvents: many(activityEvents),
  notifications: many(notifications),
  // Phase 4D
  goals: many(jarGoals),
}));

// ─── Jar Members ─────────────────────────────────────────────────────────────

export const jarMembers = pgTable("jar_members", {
  id: uuid("id").primaryKey().defaultRandom(),
  jarId: uuid("jar_id").notNull().references(() => jars.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id),
  role: text("role").notNull().default("member"),
  contributionTargetCents: integer("contribution_target_cents").notNull().default(0),
  status: text("status").notNull().default("active"),
  joinedAt: timestamp("joined_at"),
  leftAt: timestamp("left_at"),
  removedAt: timestamp("removed_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("jar_members_jar_user_idx").on(t.jarId, t.userId),
  index("jar_members_jar_idx").on(t.jarId),
  index("jar_members_user_idx").on(t.userId),
]);

export const jarMembersRelations = relations(jarMembers, ({ one, many }) => ({
  jar: one(jars, { fields: [jarMembers.jarId], references: [jars.id] }),
  user: one(users, { fields: [jarMembers.userId], references: [users.id] }),
  contributions: many(contributions),
  schedules: many(contributionSchedules),
  commitmentVotes: many(commitmentVotes),
}));

// ─── Invitations ──────────────────────────────────────────────────────────────

export const invitations = pgTable("invitations", {
  id: uuid("id").primaryKey().defaultRandom(),
  jarId: uuid("jar_id").notNull().references(() => jars.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  role: text("role").notNull().default("member"),
  contributionTargetCents: integer("contribution_target_cents"),
  status: text("status").notNull().default("pending"),
  token: text("token").notNull(),
  sentAt: timestamp("sent_at").notNull().defaultNow(),
  expiresAt: timestamp("expires_at").notNull(),
  acceptedAt: timestamp("accepted_at"),
  revokedAt: timestamp("revoked_at"),
  invitedByUserId: uuid("invited_by_user_id").references(() => users.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("invitations_token_idx").on(t.token),
  index("invitations_jar_idx").on(t.jarId),
  index("invitations_email_idx").on(t.email),
]);

export const invitationsRelations = relations(invitations, ({ one }) => ({
  jar: one(jars, { fields: [invitations.jarId], references: [jars.id] }),
  invitedBy: one(users, { fields: [invitations.invitedByUserId], references: [users.id] }),
}));

// ─── Contributions ────────────────────────────────────────────────────────────

export const contributions = pgTable("contributions", {
  id: uuid("id").primaryKey().defaultRandom(),
  jarId: uuid("jar_id").notNull().references(() => jars.id, { onDelete: "cascade" }),
  memberId: uuid("member_id").notNull().references(() => jarMembers.id),
  amountCents: integer("amount_cents").notNull(),
  contributionDate: date("contribution_date").notNull(),
  status: text("status").notNull().default("simulated"),
  sourceType: text("source_type").notNull().default("manual"),
  externalPaymentId: text("external_payment_id"),
  milestoneId: uuid("milestone_id"),
  note: text("note"),
  reversedAt: timestamp("reversed_at"),
  reversalNote: text("reversal_note"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("contributions_jar_idx").on(t.jarId),
  index("contributions_member_idx").on(t.memberId),
]);

export const contributionsRelations = relations(contributions, ({ one }) => ({
  jar: one(jars, { fields: [contributions.jarId], references: [jars.id] }),
  member: one(jarMembers, { fields: [contributions.memberId], references: [jarMembers.id] }),
}));

// ─── Contribution Schedules ────────────────────────────────────────────────────

export const contributionSchedules = pgTable("contribution_schedules", {
  id: uuid("id").primaryKey().defaultRandom(),
  jarId: uuid("jar_id").notNull().references(() => jars.id, { onDelete: "cascade" }),
  memberId: uuid("member_id").notNull().references(() => jarMembers.id),
  frequency: text("frequency").notNull().default("monthly"),
  amountCents: integer("amount_cents").notNull(),
  startDate: date("start_date").notNull(),
  preferredDay: integer("preferred_day"),
  endCondition: text("end_condition").notNull().default("targetDate"),
  isPaused: boolean("is_paused").notNull().default(false),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  index("schedules_jar_idx").on(t.jarId),
  index("schedules_member_idx").on(t.memberId),
]);

export const contributionSchedulesRelations = relations(contributionSchedules, ({ one }) => ({
  jar: one(jars, { fields: [contributionSchedules.jarId], references: [jars.id] }),
  member: one(jarMembers, { fields: [contributionSchedules.memberId], references: [jarMembers.id] }),
}));

// ─── Milestones ───────────────────────────────────────────────────────────────

export const milestones = pgTable("milestones", {
  id: uuid("id").primaryKey().defaultRandom(),
  jarId: uuid("jar_id").notNull().references(() => jars.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  targetAmountCents: integer("target_amount_cents").notNull(),
  dueDate: date("due_date"),
  priority: integer("priority").notNull().default(0),
  status: text("status").notNull().default("pending"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  index("milestones_jar_idx").on(t.jarId),
]);

export const milestonesRelations = relations(milestones, ({ one, many }) => ({
  jar: one(jars, { fields: [milestones.jarId], references: [jars.id] }),
  allocations: many(milestoneAllocations),
}));

// ─── Milestone Allocations ────────────────────────────────────────────────────

export const milestoneAllocations = pgTable("milestone_allocations", {
  id: uuid("id").primaryKey().defaultRandom(),
  milestoneId: uuid("milestone_id").notNull().references(() => milestones.id, { onDelete: "cascade" }),
  contributionId: uuid("contribution_id").notNull().references(() => contributions.id),
  amountCents: integer("amount_cents").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const milestoneAllocationsRelations = relations(milestoneAllocations, ({ one }) => ({
  milestone: one(milestones, { fields: [milestoneAllocations.milestoneId], references: [milestones.id] }),
  contribution: one(contributions, { fields: [milestoneAllocations.contributionId], references: [contributions.id] }),
}));

// ─── Commitment Requests ──────────────────────────────────────────────────────

export const commitmentRequests = pgTable("commitment_requests", {
  id: uuid("id").primaryKey().defaultRandom(),
  jarId: uuid("jar_id").notNull().references(() => jars.id, { onDelete: "cascade" }),
  milestoneId: uuid("milestone_id").references(() => milestones.id),
  amountCents: integer("amount_cents").notNull(),
  purpose: text("purpose").notNull(),
  vendorName: text("vendor_name"),
  paymentDeadline: date("payment_deadline"),
  requiredThreshold: numeric("required_threshold", { precision: 4, scale: 3 }).notNull().default("0.670"),
  status: text("status").notNull().default("pending"),
  note: text("note"),
  createdByUserId: uuid("created_by_user_id").references(() => users.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  index("commitments_jar_idx").on(t.jarId),
]);

export const commitmentRequestsRelations = relations(commitmentRequests, ({ one, many }) => ({
  jar: one(jars, { fields: [commitmentRequests.jarId], references: [jars.id] }),
  milestone: one(milestones, { fields: [commitmentRequests.milestoneId], references: [milestones.id] }),
  votes: many(commitmentVotes),
}));

// ─── Commitment Votes ─────────────────────────────────────────────────────────

export const commitmentVotes = pgTable("commitment_votes", {
  id: uuid("id").primaryKey().defaultRandom(),
  commitmentRequestId: uuid("commitment_request_id").notNull().references(() => commitmentRequests.id, { onDelete: "cascade" }),
  memberId: uuid("member_id").notNull().references(() => jarMembers.id),
  vote: text("vote").notNull(),
  note: text("note"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("commitment_votes_request_member_idx").on(t.commitmentRequestId, t.memberId),
]);

export const commitmentVotesRelations = relations(commitmentVotes, ({ one }) => ({
  commitmentRequest: one(commitmentRequests, { fields: [commitmentVotes.commitmentRequestId], references: [commitmentRequests.id] }),
  member: one(jarMembers, { fields: [commitmentVotes.memberId], references: [jarMembers.id] }),
}));

// ─── Agreements ───────────────────────────────────────────────────────────────

export const agreements = pgTable("agreements", {
  id: uuid("id").primaryKey().defaultRandom(),
  jarId: uuid("jar_id").notNull().references(() => jars.id, { onDelete: "cascade" }),
  version: text("version").notNull(),
  content: text("content").notNull(),
  effectiveDate: date("effective_date").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("agreements_jar_idx").on(t.jarId),
]);

export const agreementsRelations = relations(agreements, ({ one, many }) => ({
  jar: one(jars, { fields: [agreements.jarId], references: [jars.id] }),
  acceptances: many(agreementAcceptances),
}));

// ─── Agreement Acceptances ────────────────────────────────────────────────────

export const agreementAcceptances = pgTable("agreement_acceptances", {
  id: uuid("id").primaryKey().defaultRandom(),
  agreementId: uuid("agreement_id").notNull().references(() => agreements.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id),
  acceptedAt: timestamp("accepted_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("agreement_acceptances_agreement_user_idx").on(t.agreementId, t.userId),
]);

export const agreementAcceptancesRelations = relations(agreementAcceptances, ({ one }) => ({
  agreement: one(agreements, { fields: [agreementAcceptances.agreementId], references: [agreements.id] }),
  user: one(users, { fields: [agreementAcceptances.userId], references: [users.id] }),
}));

// ─── Notifications ────────────────────────────────────────────────────────────

export const notifications = pgTable("notifications", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  type: text("type").notNull().default("general"),
  title: text("title").notNull(),
  message: text("message").notNull(),
  isRead: boolean("is_read").notNull().default(false),
  relatedJarId: uuid("related_jar_id").references(() => jars.id),
  actionUrl: text("action_url"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("notifications_user_idx").on(t.userId),
  index("notifications_jar_idx").on(t.relatedJarId),
]);

export const notificationsRelations = relations(notifications, ({ one }) => ({
  user: one(users, { fields: [notifications.userId], references: [users.id] }),
  jar: one(jars, { fields: [notifications.relatedJarId], references: [jars.id] }),
}));

// ─── Activity Events ──────────────────────────────────────────────────────────

export const activityEvents = pgTable("activity_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  jarId: uuid("jar_id").notNull().references(() => jars.id, { onDelete: "cascade" }),
  userId: uuid("user_id").references(() => users.id),
  eventType: text("event_type").notNull(),
  description: text("description").notNull(),
  amountCents: integer("amount_cents"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("activity_jar_idx").on(t.jarId),
  index("activity_user_idx").on(t.userId),
]);

export const activityEventsRelations = relations(activityEvents, ({ one }) => ({
  jar: one(jars, { fields: [activityEvents.jarId], references: [jars.id] }),
  user: one(users, { fields: [activityEvents.userId], references: [users.id] }),
}));

// ─── Payment Method Placeholders ──────────────────────────────────────────────

export const paymentMethodPlaceholders = pgTable("payment_method_placeholders", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  type: text("type").notNull().default("card"),
  label: text("label").notNull(),
  last4: text("last4"),
  brand: text("brand"),
  expiryMonth: integer("expiry_month"),
  expiryYear: integer("expiry_year"),
  isDefault: boolean("is_default").notNull().default(false),
  isSandbox: boolean("is_sandbox").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("payment_methods_user_idx").on(t.userId),
]);

export const paymentMethodPlaceholdersRelations = relations(paymentMethodPlaceholders, ({ one }) => ({
  user: one(users, { fields: [paymentMethodPlaceholders.userId], references: [users.id] }),
}));

// ─── Commitment Snapshots ─────────────────────────────────────────────────────
//
// A commitment_snapshot records the server's FIFO-lot computation at preview
// time. snapshotToken is a random hex string returned to the client; the
// client submits it at confirm time. The confirm step re-validates all
// snapshotted lots before posting the commitment transfer.
//
// agreementId / agreementVersion are NOT NULL: a contributor can only
// preview a commitment after accepting the current jar agreement.

export const commitmentSnapshots = pgTable("commitment_snapshots", {
  id: uuid("id").primaryKey().defaultRandom(),
  jarId: uuid("jar_id").notNull().references(() => jars.id, { onDelete: "cascade" }),
  memberId: uuid("member_id").notNull().references(() => jarMembers.id, { onDelete: "cascade" }),
  agreementId: uuid("agreement_id").notNull().references(() => agreements.id, { onDelete: "restrict" }),
  agreementVersion: text("agreement_version").notNull(),
  snapshotToken: text("snapshot_token").notNull(),
  totalPrincipalCents: bigint("total_principal_cents", { mode: "number" }).notNull(),
  // 'pending' | 'confirmed' | 'expired' | 'stale'
  status: text("status").notNull().default("pending"),
  expiresAt: timestamp("expires_at").notNull(),
  confirmedAt: timestamp("confirmed_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("commitment_snapshots_token_idx").on(t.snapshotToken),
  index("commitment_snapshots_member_jar_idx").on(t.memberId, t.jarId),
]);

export const commitmentSnapshotsRelations = relations(commitmentSnapshots, ({ one, many }) => ({
  jar: one(jars, { fields: [commitmentSnapshots.jarId], references: [jars.id] }),
  member: one(jarMembers, { fields: [commitmentSnapshots.memberId], references: [jarMembers.id] }),
  agreement: one(agreements, { fields: [commitmentSnapshots.agreementId], references: [agreements.id] }),
  allocations: many(commitmentSnapshotAllocations),
}));

// ─── Commitment Snapshot Allocations ──────────────────────────────────────────

export const commitmentSnapshotAllocations = pgTable("commitment_snapshot_allocations", {
  id: uuid("id").primaryKey().defaultRandom(),
  snapshotId: uuid("snapshot_id").notNull().references(() => commitmentSnapshots.id, { onDelete: "cascade" }),
  sourceFtId: uuid("source_ft_id").notNull().references(() => financialTransactions.id, { onDelete: "restrict" }),
  allocatedCents: bigint("allocated_cents", { mode: "number" }).notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("commitment_snapshot_allocations_snapshot_idx").on(t.snapshotId),
]);

export const commitmentSnapshotAllocationsRelations = relations(commitmentSnapshotAllocations, ({ one }) => ({
  snapshot: one(commitmentSnapshots, { fields: [commitmentSnapshotAllocations.snapshotId], references: [commitmentSnapshots.id] }),
  sourceFt: one(financialTransactions, { fields: [commitmentSnapshotAllocations.sourceFtId], references: [financialTransactions.id] }),
}));

// ─── Fund Commitments ─────────────────────────────────────────────────────────
//
// One row per (member, jar): a member can only commit once per jar.
// agreementId / agreementVersion are NOT NULL and immutable — preserved even
// if the jar agreement changes later. financialTransactionId links to the
// commitment_transfer FT (CTRB_REFUNDABLE DR / CTRB_COMMITTED CR).

export const fundCommitments = pgTable("fund_commitments", {
  id: uuid("id").primaryKey().defaultRandom(),
  jarId: uuid("jar_id").notNull().references(() => jars.id, { onDelete: "restrict" }),
  memberId: uuid("member_id").notNull().references(() => jarMembers.id, { onDelete: "restrict" }),
  snapshotId: uuid("snapshot_id").notNull().references(() => commitmentSnapshots.id, { onDelete: "restrict" }),
  agreementId: uuid("agreement_id").notNull().references(() => agreements.id, { onDelete: "restrict" }),
  agreementVersion: text("agreement_version").notNull(),
  totalCommittedCents: bigint("total_committed_cents", { mode: "number" }).notNull(),
  financialTransactionId: uuid("financial_transaction_id").references(() => financialTransactions.id, { onDelete: "restrict" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("fund_commitments_member_jar_idx").on(t.memberId, t.jarId),
  index("fund_commitments_jar_idx").on(t.jarId),
  index("fund_commitments_snapshot_idx").on(t.snapshotId),
]);

export const fundCommitmentsRelations = relations(fundCommitments, ({ one, many }) => ({
  jar: one(jars, { fields: [fundCommitments.jarId], references: [jars.id] }),
  member: one(jarMembers, { fields: [fundCommitments.memberId], references: [jarMembers.id] }),
  snapshot: one(commitmentSnapshots, { fields: [fundCommitments.snapshotId], references: [commitmentSnapshots.id] }),
  agreement: one(agreements, { fields: [fundCommitments.agreementId], references: [agreements.id] }),
  financialTransaction: one(financialTransactions, { fields: [fundCommitments.financialTransactionId], references: [financialTransactions.id] }),
  allocations: many(commitmentAllocations),
}));

// ─── Commitment Allocations ────────────────────────────────────────────────────

export const commitmentAllocations = pgTable("commitment_allocations", {
  id: uuid("id").primaryKey().defaultRandom(),
  fundCommitmentId: uuid("fund_commitment_id").notNull().references(() => fundCommitments.id, { onDelete: "cascade" }),
  sourceFtId: uuid("source_ft_id").notNull().references(() => financialTransactions.id, { onDelete: "restrict" }),
  allocatedCents: bigint("allocated_cents", { mode: "number" }).notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("commitment_allocations_commitment_idx").on(t.fundCommitmentId),
  index("commitment_allocations_source_ft_idx").on(t.sourceFtId),
]);

export const commitmentAllocationsRelations = relations(commitmentAllocations, ({ one }) => ({
  fundCommitment: one(fundCommitments, { fields: [commitmentAllocations.fundCommitmentId], references: [fundCommitments.id] }),
  sourceFt: one(financialTransactions, { fields: [commitmentAllocations.sourceFtId], references: [financialTransactions.id] }),
}));

// ─── Refund Requests ──────────────────────────────────────────────────────────
//
// One row per contributor refund request. Replaces refund_request_placeholders
// (dropped in migration 0015). Tracks aggregate status across all allocations.
//
// Aggregate status lifecycle:
//   pending_provider → processing → completed | partially_failed | failed | cancelled
//
// reservationFtId links to the refund_reservation FT that posted:
//   CTRB_REFUNDABLE DR / REFUND_PENDING CR (at request creation time)

export const refundRequests = pgTable("refund_requests", {
  id: uuid("id").primaryKey().defaultRandom(),
  jarId: uuid("jar_id").notNull().references(() => jars.id, { onDelete: "restrict" }),
  memberId: uuid("member_id").notNull().references(() => jarMembers.id, { onDelete: "restrict" }),
  requestedCents: bigint("requested_cents", { mode: "number" }).notNull(),
  // 'pending_provider'|'processing'|'completed'|'partially_failed'|'failed'|'cancelled'
  status: text("status").notNull().default("pending_provider"),
  reservationFtId: uuid("reservation_ft_id").references(() => financialTransactions.id, { onDelete: "restrict" }),
  reason: text("reason"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  index("refund_requests_member_jar_idx").on(t.memberId, t.jarId),
  index("refund_requests_status_idx").on(t.status),
]);

export const refundRequestsRelations = relations(refundRequests, ({ one, many }) => ({
  jar: one(jars, { fields: [refundRequests.jarId], references: [jars.id] }),
  member: one(jarMembers, { fields: [refundRequests.memberId], references: [jarMembers.id] }),
  reservationFt: one(financialTransactions, { fields: [refundRequests.reservationFtId], references: [financialTransactions.id] }),
  allocations: many(refundAllocations),
}));

// ─── Refund Allocations ────────────────────────────────────────────────────────
//
// One row per source Stripe PI. Each allocation is dispatched as a separate
// Stripe refund call (idempotency key: dripjar-refund:<allocationId>).
//
// provider_status lifecycle (per-allocation):
//   pending → requires_action | succeeded | failed | cancelled
//   Terminal states (no regression): succeeded, failed, cancelled
//
// stripeRefundId: populated by the dispatcher after Stripe confirms.
// finalizationFtId: populated on finalization (succeeded) or reversal
//   (failed/cancelled) — the FT that posts the complementary ledger entry.

export const refundAllocations = pgTable("refund_allocations", {
  id: uuid("id").primaryKey().defaultRandom(),
  refundRequestId: uuid("refund_request_id").notNull().references(() => refundRequests.id, { onDelete: "cascade" }),
  sourceFtId: uuid("source_ft_id").notNull().references(() => financialTransactions.id, { onDelete: "restrict" }),
  allocatedCents: bigint("allocated_cents", { mode: "number" }).notNull(),
  // 'pending'|'requires_action'|'succeeded'|'failed'|'cancelled'
  providerStatus: text("provider_status").notNull().default("pending"),
  stripeRefundId: text("stripe_refund_id"),
  // FK to finalization or reversal FT (posted when terminal state is reached)
  finalizationFtId: uuid("finalization_ft_id").references(() => financialTransactions.id, { onDelete: "restrict" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  index("refund_allocations_request_idx").on(t.refundRequestId),
  index("refund_allocations_source_ft_idx").on(t.sourceFtId),
  uniqueIndex("refund_allocations_stripe_refund_unique_idx").on(t.stripeRefundId),
]);

export const refundAllocationsRelations = relations(refundAllocations, ({ one }) => ({
  refundRequest: one(refundRequests, { fields: [refundAllocations.refundRequestId], references: [refundRequests.id] }),
  sourceFt: one(financialTransactions, { fields: [refundAllocations.sourceFtId], references: [financialTransactions.id] }),
  finalizationFt: one(financialTransactions, { fields: [refundAllocations.finalizationFtId], references: [financialTransactions.id] }),
}));

// ─── Reminder Sent Events ─────────────────────────────────────────────────────
// Idempotency table: each row represents one logical reminder that has already
// been processed (notification created + email attempted). The unique event_key
// prevents duplicate delivery even if the processor runs multiple times per day.
//
// Key format examples:
//   "contribution_due:${scheduleId}:${dueDateISO}"
//   "contribution_missed:${scheduleId}:${dueDateISO}"
//   "cutoff_upcoming_7d:${jarId}:${cutoffDateISO}:${userId}"
//   "cutoff_upcoming_1d:${jarId}:${cutoffDateISO}:${userId}"
//   "cutoff_reached:${jarId}:${cutoffDateISO}:${userId}"
//   "agreement_required:${agreementId}:${userId}"

export const reminderSentEvents = pgTable("reminder_sent_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  eventKey: text("event_key").notNull(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  jarId: uuid("jar_id").references(() => jars.id, { onDelete: "set null" }),
  eventType: text("event_type").notNull(),
  sentAt: timestamp("sent_at").notNull().defaultNow(),
  // Email delivery state tracking (Phase 3 conformance)
  // emailStatus: 'pending' | 'sending' | 'sent' | 'failed' | 'skipped_preference'
  // - 'pending'            : newly inserted, email not yet attempted
  // - 'sending'            : atomically claimed by a processor; email in-flight.
  //                          A 'sending' row > 5 minutes old is treated as stale
  //                          (process crash) and is re-claimable for retry.
  // - 'sent'               : email delivered successfully; never retried
  // - 'failed'             : last delivery attempt failed; retried on next run
  // - 'skipped_preference' : user preference = disabled; permanently skipped
  emailStatus: text("email_status").notNull().default("pending"),
  emailSentAt: timestamp("email_sent_at"),
  emailAttemptCount: integer("email_attempt_count").notNull().default(0),
  emailLastAttemptAt: timestamp("email_last_attempt_at"),
}, (t) => [
  uniqueIndex("reminder_sent_events_key_idx").on(t.eventKey),
  index("reminder_sent_events_user_idx").on(t.userId),
]);

export const reminderSentEventsRelations = relations(reminderSentEvents, ({ one }) => ({
  user: one(users, { fields: [reminderSentEvents.userId], references: [users.id] }),
  jar: one(jars, { fields: [reminderSentEvents.jarId], references: [jars.id] }),
}));

// ─── Ledger Accounts (Chart of Accounts) ─────────────────────────────────────
//
// System-seeded accounts. Codes and their semantics are fixed at schema level:
//
//  Code              Type       Normal balance  Meaning
//  ─────────────────────────────────────────────────────────────────────────────
//  EXT_PAY_CLR       asset      debit           Total customer charge clearing
//  CTRB_REFUNDABLE   liability  credit          Contributor refundable principal
//  CTRB_COMMITTED    liability  credit          Committed principal (locked)
//  DJ_FEE_REVENUE    revenue    credit          DripJar 3% service fee earned
//  PROC_FEE_CLR      liability  credit          Processing-fee pass-through
//  REFUND_CLR        asset      debit           Refund outflow clearing
//  PAYOUT_CLR        asset      debit           Future payout destination clearing
//
// Debit/credit convention:
//   Assets/Expenses  → debit increases, credit decreases
//   Liabilities/Equity/Revenue → credit increases, debit decreases
//
// Ledger entries are immutable once posted. Corrections use compensating entries.

export const ledgerAccounts = pgTable("ledger_accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: text("code").notNull(),
  name: text("name").notNull(),
  // 'asset' | 'liability' | 'revenue' | 'expense' | 'equity'
  accountType: text("account_type").notNull(),
  // 'debit' | 'credit' — normal/positive balance direction
  normalBalance: text("normal_balance").notNull(),
  currency: text("currency").notNull().default("USD"),
  description: text("description"),
  isSystemAccount: boolean("is_system_account").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("ledger_accounts_code_idx").on(t.code),
]);

// ─── Financial Transactions ───────────────────────────────────────────────────
//
// One row per financial event (contribution, refund, commitment_transfer, …).
// Captures all fee components at the time of the event so historical records
// are stable even if rates change later.
//
// Transaction types:
//   contribution         – initial drip of principal into a jar
//   refund               – pre-commit principal return to contributor
//   commitment_transfer  – moves refundable → committed principal
//   payout               – future: committed → organizer bank or card
//   card_spend           – future: DripJar Card charge
//   adjustment           – manual correction
//   reversal             – explicit compensating reversal
//
// Provider fields (providerType, providerTransactionId, providerStatus) are
// NULL/not_applicable in Phase 4A. They will be populated by Phase 4B (Stripe).
//
// Fund destination abstraction:
//   fundDestinationType = NULL          (not yet routed)
//                       = 'organizer_bank_payout' (future)
//                       = 'dripjar_card'          (future)
//
// Money columns use BIGINT to accommodate platform-wide ledger aggregation
// without integer overflow ($21M INTEGER ceiling is too narrow for aggregates).
// Individual transaction amounts are bounded by jar goals (INTEGER), but
// storing them as BIGINT here keeps the ledger future-safe and avoids any
// type mismatch when summing across millions of transactions.

export const financialTransactions = pgTable("financial_transactions", {
  id: uuid("id").primaryKey().defaultRandom(),
  jarId: uuid("jar_id").notNull().references(() => jars.id, { onDelete: "restrict" }),
  memberId: uuid("member_id").notNull().references(() => jarMembers.id, { onDelete: "restrict" }),
  // 'contribution'|'refund'|'commitment_transfer'|'payout'|'card_spend'|'adjustment'|'reversal'
  transactionType: text("transaction_type").notNull(),
  currency: text("currency").notNull().default("USD"),
  // Principal the contributor intends to drip into the jar
  requestedPrincipalCents: bigint("requested_principal_cents", { mode: "number" }).notNull(),
  // DripJar 3% service fee computed at transaction time (non-refundable)
  dripJarFeeCents: bigint("dripjar_fee_cents", { mode: "number" }).notNull(),
  // Rate stored so historical records are stable if rate changes
  dripJarFeeRateBps: integer("dripjar_fee_rate_bps").notNull(),
  // Provider fee estimate shown to customer before confirmation
  processingFeeEstimatedCents: bigint("processing_fee_estimated_cents", { mode: "number" }).notNull().default(0),
  // Actual provider fee from reconciliation (Phase 4B+); null until confirmed
  processingFeeActualCents: bigint("processing_fee_actual_cents", { mode: "number" }),
  // Total quoted to customer = principal + DripJar fee + estimated processing fee
  totalQuotedCents: bigint("total_quoted_cents", { mode: "number" }).notNull(),
  // Payment provider (null Phase 4A; 'stripe' Phase 4B+)
  providerType: text("provider_type"),
  providerTransactionId: text("provider_transaction_id"),
  // Phase 4B providerStatus values (extends Phase 4A not_applicable|pending):
  //   'not_applicable'   — simulated / no payment provider
  //   'pending'          — created but not yet submitted to provider
  //   'quoted'           — fee quote persisted; awaiting PI creation (30-min TTL)
  //   'provider_created' — PaymentIntent created at Stripe, not yet confirmed
  //   'processing'       — PaymentIntent processing (ACH in-flight)
  //   'succeeded'        — confirmed via webhook; ledger posted
  //   'failed'           — payment failed
  //   'cancelled'        — PaymentIntent cancelled
  providerStatus: text("provider_status").notNull().default("not_applicable"),
  // Phase 4B: quote expiry — null for non-quoted transactions
  quoteExpiresAt: timestamp("quote_expires_at"),
  // Phase 4B: 'us_bank_account' | 'card' | null for non-Stripe transactions
  paymentMethodCategory: text("payment_method_category"),
  // 'pending'|'posted'|'failed'
  ledgerPostingStatus: text("ledger_posting_status").notNull().default("pending"),
  // Set once ledger entries are posted
  ledgerId: uuid("ledger_id"),
  // Future payout routing: null | 'organizer_bank_payout' | 'dripjar_card'
  fundDestinationType: text("fund_destination_type"),
  // Caller-provided deduplication key; unique constraint prevents double-posts
  idempotencyKey: text("idempotency_key").notNull(),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("financial_transactions_idempotency_key_idx").on(t.idempotencyKey),
  index("financial_transactions_jar_idx").on(t.jarId),
  index("financial_transactions_member_idx").on(t.memberId),
  index("financial_transactions_ledger_idx").on(t.ledgerId),
]);

export const financialTransactionsRelations = relations(financialTransactions, ({ one }) => ({
  jar: one(jars, { fields: [financialTransactions.jarId], references: [jars.id] }),
  member: one(jarMembers, { fields: [financialTransactions.memberId], references: [jarMembers.id] }),
  ledgerTransaction: one(ledgerTransactions, {
    fields: [financialTransactions.ledgerId],
    references: [ledgerTransactions.id],
  }),
}));

// ─── Ledger Transactions ──────────────────────────────────────────────────────
//
// Groups a balanced set of ledger entries. Immutable once postedAt is set.
// Every ledger_transaction must belong to a financial_transaction — the FK is
// NOT NULL and enforced at both the application layer and the DB layer.

export const ledgerTransactions = pgTable("ledger_transactions", {
  id: uuid("id").primaryKey().defaultRandom(),
  financialTransactionId: uuid("financial_transaction_id")
    .notNull()
    .references(() => financialTransactions.id, { onDelete: "restrict" }),
  description: text("description").notNull(),
  currency: text("currency").notNull().default("USD"),
  // Set at creation and never changed — enforced at application layer.
  // Any correction requires a new compensating ledger transaction.
  postedAt: timestamp("posted_at").notNull().defaultNow(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("ledger_transactions_financial_tx_idx").on(t.financialTransactionId),
]);

export const ledgerTransactionsRelations = relations(ledgerTransactions, ({ one, many }) => ({
  financialTransaction: one(financialTransactions, {
    fields: [ledgerTransactions.financialTransactionId],
    references: [financialTransactions.id],
  }),
  entries: many(ledgerEntries),
}));

// ─── Ledger Entries ───────────────────────────────────────────────────────────
//
// Individual debit/credit lines. IMMUTABLE after insert — there are no update
// or delete endpoints for posted entries. Corrections use new compensating
// ledger_transactions with reversing entries.
//
// amountCents must be > 0. Negative balances are modelled via entry_type
// ('debit' vs 'credit'), not via negative amounts.
//
// Uses BIGINT for amountCents to support large-scale platform aggregation.

export const ledgerEntries = pgTable("ledger_entries", {
  id: uuid("id").primaryKey().defaultRandom(),
  ledgerTransactionId: uuid("ledger_transaction_id")
    .notNull()
    .references(() => ledgerTransactions.id, { onDelete: "restrict" }),
  accountId: uuid("account_id")
    .notNull()
    .references(() => ledgerAccounts.id, { onDelete: "restrict" }),
  // 'debit' | 'credit'
  entryType: text("entry_type").notNull(),
  // Positive amount only; direction encoded in entryType
  amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
  currency: text("currency").notNull().default("USD"),
  memo: text("memo"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("ledger_entries_tx_idx").on(t.ledgerTransactionId),
  index("ledger_entries_account_idx").on(t.accountId),
]);

export const ledgerEntriesRelations = relations(ledgerEntries, ({ one }) => ({
  ledgerTransaction: one(ledgerTransactions, {
    fields: [ledgerEntries.ledgerTransactionId],
    references: [ledgerTransactions.id],
  }),
  account: one(ledgerAccounts, {
    fields: [ledgerEntries.accountId],
    references: [ledgerAccounts.id],
  }),
}));

// ─── Stripe Webhook Events ────────────────────────────────────────────────────
//
// Idempotency store for incoming Stripe webhook events.
// Each Stripe event ID is stored exactly once; duplicate deliveries are
// detected via the unique constraint on stripeEventId and discarded.
//
// processingStatus lifecycle:
//   'received'   → initial state on insert
//   'processing' → claimed by handler (set inside the success handler tx)
//   'processed'  → event fully handled and ledger posted (if applicable)
//   'failed'     → handler threw; Stripe will retry
//   'ignored'    → unknown/unsupported event type; 200 returned to Stripe

export const stripeWebhookEvents = pgTable("stripe_webhook_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  stripeEventId: text("stripe_event_id").notNull(),
  eventType: text("event_type").notNull(),
  stripeCreatedAt: timestamp("stripe_created_at").notNull(),
  receivedAt: timestamp("received_at").notNull().defaultNow(),
  processedAt: timestamp("processed_at"),
  // 'received'|'processing'|'processed'|'failed'|'ignored'
  processingStatus: text("processing_status").notNull().default("received"),
  financialTransactionId: uuid("financial_transaction_id").references(
    () => financialTransactions.id,
  ),
  errorMessage: text("error_message"),
  attemptCount: integer("attempt_count").notNull().default(0),
}, (t) => [
  uniqueIndex("stripe_webhook_events_stripe_event_id_idx").on(t.stripeEventId),
  index("stripe_webhook_events_ft_id_idx").on(t.financialTransactionId),
  index("stripe_webhook_events_status_idx").on(t.processingStatus),
]);

export const stripeWebhookEventsRelations = relations(stripeWebhookEvents, ({ one }) => ({
  financialTransaction: one(financialTransactions, {
    fields: [stripeWebhookEvents.financialTransactionId],
    references: [financialTransactions.id],
  }),
}));

// ─── Add financial_transactions to existing relation maps ─────────────────────

export const jarsFinancialRelations = relations(jars, ({ many: _many }) => ({
  financialTransactions: _many(financialTransactions),
}));

export const jarMembersFinancialRelations = relations(jarMembers, ({ many: _many }) => ({
  financialTransactions: _many(financialTransactions),
}));

// ─── Type exports ─────────────────────────────────────────────────────────────

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Profile = typeof profiles.$inferSelect;
export type NewProfile = typeof profiles.$inferInsert;
export type Jar = typeof jars.$inferSelect;
export type NewJar = typeof jars.$inferInsert;
export type JarMember = typeof jarMembers.$inferSelect;
export type NewJarMember = typeof jarMembers.$inferInsert;
export type Invitation = typeof invitations.$inferSelect;
export type NewInvitation = typeof invitations.$inferInsert;
export type Contribution = typeof contributions.$inferSelect;
export type NewContribution = typeof contributions.$inferInsert;
export type ContributionSchedule = typeof contributionSchedules.$inferSelect;
export type NewContributionSchedule = typeof contributionSchedules.$inferInsert;
export type Milestone = typeof milestones.$inferSelect;
export type NewMilestone = typeof milestones.$inferInsert;
export type MilestoneAllocation = typeof milestoneAllocations.$inferSelect;
export type NewMilestoneAllocation = typeof milestoneAllocations.$inferInsert;
export type CommitmentRequest = typeof commitmentRequests.$inferSelect;
export type NewCommitmentRequest = typeof commitmentRequests.$inferInsert;
export type CommitmentVote = typeof commitmentVotes.$inferSelect;
export type NewCommitmentVote = typeof commitmentVotes.$inferInsert;
export type Agreement = typeof agreements.$inferSelect;
export type NewAgreement = typeof agreements.$inferInsert;
export type AgreementAcceptance = typeof agreementAcceptances.$inferSelect;
export type NewAgreementAcceptance = typeof agreementAcceptances.$inferInsert;
export type Notification = typeof notifications.$inferSelect;
export type NewNotification = typeof notifications.$inferInsert;
export type ActivityEvent = typeof activityEvents.$inferSelect;
export type NewActivityEvent = typeof activityEvents.$inferInsert;
export type PaymentMethodPlaceholder = typeof paymentMethodPlaceholders.$inferSelect;
export type LedgerAccount = typeof ledgerAccounts.$inferSelect;
export type NewLedgerAccount = typeof ledgerAccounts.$inferInsert;
export type FinancialTransaction = typeof financialTransactions.$inferSelect;
export type NewFinancialTransaction = typeof financialTransactions.$inferInsert;
export type LedgerTransaction = typeof ledgerTransactions.$inferSelect;
export type NewLedgerTransaction = typeof ledgerTransactions.$inferInsert;
export type LedgerEntry = typeof ledgerEntries.$inferSelect;
export type NewLedgerEntry = typeof ledgerEntries.$inferInsert;
export type StripeWebhookEvent = typeof stripeWebhookEvents.$inferSelect;
export type NewStripeWebhookEvent = typeof stripeWebhookEvents.$inferInsert;
// Phase 4C
export type CommitmentSnapshot = typeof commitmentSnapshots.$inferSelect;
export type NewCommitmentSnapshot = typeof commitmentSnapshots.$inferInsert;
export type CommitmentSnapshotAllocation = typeof commitmentSnapshotAllocations.$inferSelect;
export type NewCommitmentSnapshotAllocation = typeof commitmentSnapshotAllocations.$inferInsert;
export type FundCommitment = typeof fundCommitments.$inferSelect;
export type NewFundCommitment = typeof fundCommitments.$inferInsert;
export type CommitmentAllocation = typeof commitmentAllocations.$inferSelect;
export type NewCommitmentAllocation = typeof commitmentAllocations.$inferInsert;
export type RefundRequest = typeof refundRequests.$inferSelect;
export type NewRefundRequest = typeof refundRequests.$inferInsert;
export type RefundAllocation = typeof refundAllocations.$inferSelect;
export type NewRefundAllocation = typeof refundAllocations.$inferInsert;

// ─── Jar Goals — Phase 4D ─────────────────────────────────────────────────────
//
// Planning metadata only. No ledger_entries, financial_transactions, or Stripe
// calls are created by goal mutations. All funding allocation is derived at
// query time via a pure waterfall function over the existing ledger.
//
// Invariants enforced server-side:
//   SUM(active goal targets) ≤ jars.goalAmountCents  (locked in FOR UPDATE txn)
//   Archived goals do not participate in the waterfall
//   Hard delete only when jar.status IN ('Draft','Inviting')
//   Soft archive otherwise (preserve for history/audit)

export const jarGoals = pgTable("jar_goals", {
  id: uuid("id").primaryKey().defaultRandom(),
  jarId: uuid("jar_id").notNull().references(() => jars.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  targetPrincipalCents: integer("target_principal_cents").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  // 'active' | 'archived'
  status: text("status").notNull().default("active"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  archivedAt: timestamp("archived_at"),
}, (t) => [
  index("jar_goals_jar_id_status_sort_idx").on(t.jarId, t.status, t.sortOrder),
]);

export const jarGoalsRelations = relations(jarGoals, ({ one }) => ({
  jar: one(jars, { fields: [jarGoals.jarId], references: [jars.id] }),
}));

// Phase 4D
export type JarGoal = typeof jarGoals.$inferSelect;
export type NewJarGoal = typeof jarGoals.$inferInsert;
