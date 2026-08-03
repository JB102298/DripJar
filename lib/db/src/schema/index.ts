import {
  pgTable,
  text,
  integer,
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
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("profiles_user_id_idx").on(t.userId),
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

// ─── Refund Request Placeholders ─────────────────────────────────────────────

export const refundRequestPlaceholders = pgTable("refund_request_placeholders", {
  id: uuid("id").primaryKey().defaultRandom(),
  jarId: uuid("jar_id").notNull().references(() => jars.id),
  memberId: uuid("member_id").notNull().references(() => jarMembers.id),
  amountCents: integer("amount_cents").notNull(),
  reason: text("reason"),
  status: text("status").notNull().default("pending"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const refundRequestPlaceholdersRelations = relations(refundRequestPlaceholders, ({ one }) => ({
  jar: one(jars, { fields: [refundRequestPlaceholders.jarId], references: [jars.id] }),
  member: one(jarMembers, { fields: [refundRequestPlaceholders.memberId], references: [jarMembers.id] }),
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
export type RefundRequestPlaceholder = typeof refundRequestPlaceholders.$inferSelect;
