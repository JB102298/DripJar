/**
 * Precise, SQL-level fixtures for the reminder processor.
 *
 * ─── WHY NOT THE HTTP API ────────────────────────────────────────────────────
 *
 * The processor's selection rules turn on states the API deliberately refuses
 * to create: a cutoff date in the past, a schedule that started six months ago,
 * an inactive member holding an active schedule, an agreement nobody accepted.
 * Those are exactly the rows selection has to include or exclude correctly, so
 * they are written directly. Everything the API *would* enforce is irrelevant
 * here — these fixtures exist to be read by the processor, never to model a
 * legal user journey.
 *
 * Every account carries the caller's fixture tag, so teardown finds and removes
 * all of it by the same query-driven route as every other fixture.
 */

import { pool } from "@workspace/db";
import type { FixtureTag } from "./fixtures.js";

const FIXTURE_HASH = "$2b$10$reminderfixturenotarealhashxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";

async function one<T>(text: string, params: unknown[]): Promise<T> {
  const res = await pool.query(text, params);
  return res.rows[0] as T;
}

/** UTC calendar date `offsetDays` from today, as yyyy-MM-dd. Matches the processor. */
export function utcDay(offsetDays: number, now: Date = new Date()): string {
  const base = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return new Date(base + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

export interface EmailPrefs {
  contributionReminders?: boolean;
  cutoffReminders?: boolean;
  lifecycle?: boolean;
}

export async function makeUser(
  fixtures: FixtureTag,
  suffix: string,
  prefs: EmailPrefs = {},
): Promise<{ userId: string; email: string; displayName: string }> {
  const email = fixtures.email(suffix);
  const displayName = `Reminder ${suffix}`;
  const user = await one<{ id: string }>(
    `insert into users (email, password_hash, email_verified)
     values ($1, $2, true) returning id`,
    [email, FIXTURE_HASH],
  );
  await pool.query(
    `insert into profiles
       (user_id, first_name, last_name, display_name,
        email_pref_contribution_reminders, email_pref_cutoff_reminders, email_pref_lifecycle)
     values ($1, 'Reminder', $2, $3, $4, $5, $6)`,
    [
      user.id,
      suffix,
      displayName,
      prefs.contributionReminders ?? true,
      prefs.cutoffReminders ?? true,
      prefs.lifecycle ?? true,
    ],
  );
  return { userId: user.id, email, displayName };
}

/** A user with no profile row — the processor must skip them everywhere. */
export async function makeProfilelessUser(
  fixtures: FixtureTag,
  suffix: string,
): Promise<{ userId: string; email: string }> {
  const email = fixtures.email(suffix);
  const user = await one<{ id: string }>(
    `insert into users (email, password_hash, email_verified)
     values ($1, $2, true) returning id`,
    [email, FIXTURE_HASH],
  );
  return { userId: user.id, email };
}

export interface JarSpec {
  status?: string;
  /** yyyy-MM-dd, or null for a jar that can never fire a cutoff reminder. */
  cutoffDate?: string | null;
  timeZone?: string;
  targetDate?: string;
}

export async function makeJar(
  fixtures: FixtureTag,
  organizerId: string,
  label: string,
  spec: JarSpec = {},
): Promise<{ jarId: string; jarName: string }> {
  const jarName = fixtures.name(label);
  const slug = `${fixtures.tag}-${label}-${Math.random().toString(36).slice(2, 10)}`;
  const jar = await one<{ id: string }>(
    `insert into jars
       (organizer_id, name, slug, category, target_date, cutoff_date,
        goal_amount_cents, status, currency, time_zone, launched_at)
     values ($1, $2, $3, 'Vacation', $4::date, $5::date, 100000, $6, 'USD', $7, now())
     returning id`,
    [
      organizerId,
      jarName,
      slug,
      spec.targetDate ?? utcDay(400),
      spec.cutoffDate ?? null,
      spec.status ?? "Saving",
      spec.timeZone ?? "America/New_York",
    ],
  );
  return { jarId: jar.id, jarName };
}

export async function makeMember(
  jarId: string,
  userId: string,
  spec: { status?: string; role?: string } = {},
): Promise<string> {
  const row = await one<{ id: string }>(
    `insert into jar_members (jar_id, user_id, role, status, joined_at)
     values ($1, $2, $3, $4, now()) returning id`,
    [jarId, userId, spec.role ?? "member", spec.status ?? "active"],
  );
  return row.id;
}

export interface ScheduleSpec {
  frequency?: string;
  amountCents?: number;
  startDate?: string;
  preferredDay?: number | null;
  isActive?: boolean;
  isPaused?: boolean;
}

export async function makeSchedule(
  jarId: string,
  memberId: string,
  spec: ScheduleSpec = {},
): Promise<string> {
  const row = await one<{ id: string }>(
    `insert into contribution_schedules
       (jar_id, member_id, frequency, amount_cents, start_date, preferred_day, is_active, is_paused)
     values ($1, $2, $3, $4, $5::date, $6, $7, $8) returning id`,
    [
      jarId,
      memberId,
      spec.frequency ?? "monthly",
      spec.amountCents ?? 25_000,
      spec.startDate ?? utcDay(0),
      spec.preferredDay ?? null,
      spec.isActive ?? true,
      spec.isPaused ?? false,
    ],
  );
  return row.id;
}

export async function makeAgreement(
  jarId: string,
  spec: { version?: string; createdAt?: Date } = {},
): Promise<string> {
  const row = await one<{ id: string }>(
    `insert into agreements (jar_id, version, content, effective_date, created_at)
     values ($1, $2, 'Reminder fixture agreement', current_date, coalesce($3::timestamp, now()))
     returning id`,
    [jarId, spec.version ?? "1.0", spec.createdAt ?? null],
  );
  return row.id;
}

export async function acceptAgreement(agreementId: string, userId: string): Promise<void> {
  await pool.query(
    `insert into agreement_acceptances (agreement_id, user_id) values ($1, $2)`,
    [agreementId, userId],
  );
}

export async function makeContribution(
  jarId: string,
  memberId: string,
  spec: { amountCents: number; contributionDate: string; status?: string },
): Promise<void> {
  await pool.query(
    `insert into contributions (jar_id, member_id, amount_cents, contribution_date, status)
     values ($1, $2, $3, $4::date, $5)`,
    [jarId, memberId, spec.amountCents, spec.contributionDate, spec.status ?? "completed"],
  );
}

// ─── Observation ─────────────────────────────────────────────────────────────

export interface ReminderEventRow {
  eventKey: string;
  userId: string;
  jarId: string | null;
  eventType: string;
  emailStatus: string;
  emailAttemptCount: number;
  emailSentAt: Date | null;
}

/** Every reminder event belonging to a set of accounts, ordered by key. */
export async function reminderEventsFor(userIds: string[]): Promise<ReminderEventRow[]> {
  if (userIds.length === 0) return [];
  const res = await pool.query(
    `select event_key as "eventKey", user_id as "userId", jar_id as "jarId",
            event_type as "eventType", email_status as "emailStatus",
            email_attempt_count as "emailAttemptCount", email_sent_at as "emailSentAt"
       from reminder_sent_events
      where user_id = any($1::uuid[])
      order by event_key`,
    [userIds],
  );
  return res.rows as ReminderEventRow[];
}

export interface NotificationRow {
  userId: string;
  type: string;
  title: string;
  message: string;
  relatedJarId: string | null;
  actionUrl: string | null;
}

export async function notificationsFor(userIds: string[]): Promise<NotificationRow[]> {
  if (userIds.length === 0) return [];
  const res = await pool.query(
    `select user_id as "userId", type, title, message,
            related_jar_id as "relatedJarId", action_url as "actionUrl"
       from notifications
      where user_id = any($1::uuid[])
      order by type, title, created_at`,
    [userIds],
  );
  return res.rows as NotificationRow[];
}

/** Financial and ledger rows attached to a set of jars. Must always be zero. */
export async function financialFootprintFor(jarIds: string[]): Promise<{
  contributions: number;
  financialTransactions: number;
  ledgerTransactions: number;
  ledgerEntries: number;
}> {
  if (jarIds.length === 0) {
    return { contributions: 0, financialTransactions: 0, ledgerTransactions: 0, ledgerEntries: 0 };
  }
  const res = await pool.query(
    `select
       (select count(*)::int from contributions where jar_id = any($1::uuid[])) as "contributions",
       (select count(*)::int from financial_transactions where jar_id = any($1::uuid[])) as "financialTransactions",
       (select count(*)::int from ledger_transactions lt
          join financial_transactions ft on ft.id = lt.financial_transaction_id
         where ft.jar_id = any($1::uuid[])) as "ledgerTransactions",
       (select count(*)::int from ledger_entries le
          join ledger_transactions lt on lt.id = le.ledger_transaction_id
          join financial_transactions ft on ft.id = lt.financial_transaction_id
         where ft.jar_id = any($1::uuid[])) as "ledgerEntries"`,
    [jarIds],
  );
  return res.rows[0] as {
    contributions: number;
    financialTransactions: number;
    ledgerTransactions: number;
    ledgerEntries: number;
  };
}
