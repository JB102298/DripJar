/**
 * M3 — reminder candidate selection.
 *
 * The processor's selection stopped being a JavaScript walk over every row and
 * became three keyset-paged SQL queries. This file exists to prove that the
 * change moved *where* the decision is made without changing *what* it decides.
 *
 * ─── HOW PARITY IS ESTABLISHED ───────────────────────────────────────────────
 *
 * `preM3ExpectedEventKeys` below is the pre-M3 algorithm, transcribed: the same
 * three loops, the same per-row lookups, the same `continue`s, the same event
 * key strings — scoped to this file's jars so it can run row-at-a-time without
 * costing a minute. It is an oracle, not a helper: the processor's actual
 * output is compared against it rather than against a hand-written list, so a
 * selection rule that drifts fails here even if someone updates the expected
 * set to match.
 *
 * The fixture population underneath it is built to make that comparison worth
 * something. Every reminder type fires at least once, and every exclusion the
 * old code expressed as a `continue` is represented by a row that must produce
 * nothing: a paused schedule, an inactive one, a removed member, a jar in each
 * non-Saving status, a user with no profile, an accepted agreement, a jar with
 * no agreement at all, and cutoff dates on both sides of all three windows.
 *
 * ─── SCOPING ─────────────────────────────────────────────────────────────────
 *
 * The endpoint is global by design and other test files are running against the
 * same database. Every assertion here reads only rows belonging to this file's
 * tagged accounts and jars, and the sweep runs under the shared advisory lock
 * so no other file's teardown can delete a row mid-scan.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { pool } from "@workspace/db";
import app from "../app.js";
import {
  captureOrphanBaseline,
  createFixtureTag,
  teardownFixtures,
  withGlobalSweepExclusion,
  type OrphanBaseline,
} from "./support/fixtures.js";
import {
  acceptAgreement,
  financialFootprintFor,
  makeAgreement,
  makeContribution,
  makeJar,
  makeMember,
  makeProfilelessUser,
  makeSchedule,
  makeUser,
  notificationsFor,
  reminderEventsFor,
  utcDay,
} from "./support/reminder-fixtures.js";
import { toUTCDateString, daysUntil } from "../lib/phase.js";
import { computeScheduleStatus } from "../lib/schedule-status.js";

const BASE = "/api";
const INTERNAL_TOKEN = "m3-selection-internal-token";
const FIXTURES = createFixtureTag("m3sel");

let orphanBaseline: OrphanBaseline;
const originalToken = process.env["INTERNAL_REMINDER_TOKEN"];

const runProcessor = () =>
  withGlobalSweepExclusion(() =>
    request(app)
      .post(`${BASE}/internal/process-reminders`)
      .set("X-Internal-Token", INTERNAL_TOKEN),
  );

// ─── The population ──────────────────────────────────────────────────────────

interface Population {
  /** Every account this file owns, in creation order. */
  userIds: string[];
  /** Every jar this file owns. */
  jarIds: string[];
  /** Named handles for the assertions that need one specific row. */
  h: Record<string, string>;
}

let pop: Population;

async function buildPopulation(): Promise<Population> {
  const userIds: string[] = [];
  const jarIds: string[] = [];
  const h: Record<string, string> = {};

  const user = async (suffix: string, prefs = {}) => {
    const u = await makeUser(FIXTURES, suffix, prefs);
    userIds.push(u.userId);
    return u;
  };
  const jar = async (organizerId: string, label: string, spec = {}) => {
    const j = await makeJar(FIXTURES, organizerId, label, spec);
    jarIds.push(j.jarId);
    return j;
  };

  // ── Schedule reminders ────────────────────────────────────────────────────

  // due_today — the canonical eligible contribution reminder.
  const due = await user("due");
  const dueJar = await jar(due.userId, "duejar");
  const dueMember = await makeMember(dueJar.jarId, due.userId, { role: "organizer" });
  h["dueSchedule"] = await makeSchedule(dueJar.jarId, dueMember, {
    frequency: "weekly", amountCents: 10_000, startDate: utcDay(0),
  });
  h["dueUser"] = due.userId;
  h["dueJar"] = dueJar.jarId;
  h["dueJarName"] = dueJar.jarName;

  // missed — three weekly periods elapsed, nothing contributed.
  const missed = await user("missed");
  const missedJar = await jar(missed.userId, "missedjar");
  const missedMember = await makeMember(missedJar.jarId, missed.userId, { role: "organizer" });
  h["missedSchedule"] = await makeSchedule(missedJar.jarId, missedMember, {
    frequency: "weekly", amountCents: 10_000, startDate: utcDay(-21),
  });
  h["missedUser"] = missed.userId;
  h["missedJar"] = missedJar.jarId;
  h["missedJarName"] = missedJar.jarName;

  // satisfied — four periods elapsed, all four paid, next due in four days.
  const satisfied = await user("satisfied");
  const satJar = await jar(satisfied.userId, "satjar");
  const satMember = await makeMember(satJar.jarId, satisfied.userId, { role: "organizer" });
  await makeSchedule(satJar.jarId, satMember, {
    frequency: "weekly", amountCents: 10_000, startDate: utcDay(-24),
  });
  await makeContribution(satJar.jarId, satMember, {
    amountCents: 40_000, contributionDate: utcDay(-1),
  });
  h["satisfiedUser"] = satisfied.userId;

  // due_soon — obligations met, next due date two days out. Outside every window.
  const soon = await user("soon");
  const soonJar = await jar(soon.userId, "soonjar");
  const soonMember = await makeMember(soonJar.jarId, soon.userId, { role: "organizer" });
  await makeSchedule(soonJar.jarId, soonMember, {
    frequency: "weekly", amountCents: 10_000, startDate: utcDay(-19),
  });
  await makeContribution(soonJar.jarId, soonMember, {
    amountCents: 30_000, contributionDate: utcDay(-1),
  });
  h["soonUser"] = soon.userId;

  // paused — due today but paused.
  const paused = await user("paused");
  const pausedJar = await jar(paused.userId, "pausedjar");
  const pausedMember = await makeMember(pausedJar.jarId, paused.userId, { role: "organizer" });
  await makeSchedule(pausedJar.jarId, pausedMember, {
    frequency: "weekly", amountCents: 10_000, startDate: utcDay(0), isPaused: true,
  });
  h["pausedUser"] = paused.userId;

  // inactive — due today but deactivated.
  const inactive = await user("inactive");
  const inactiveJar = await jar(inactive.userId, "inactivejar");
  const inactiveMember = await makeMember(inactiveJar.jarId, inactive.userId, { role: "organizer" });
  await makeSchedule(inactiveJar.jarId, inactiveMember, {
    frequency: "weekly", amountCents: 10_000, startDate: utcDay(0), isActive: false,
  });
  h["inactiveUser"] = inactive.userId;

  // removed member holding an otherwise-eligible schedule.
  const removed = await user("removed");
  const removedJar = await jar(removed.userId, "removedjar");
  const removedMember = await makeMember(removedJar.jarId, removed.userId, { status: "removed" });
  await makeSchedule(removedJar.jarId, removedMember, {
    frequency: "weekly", amountCents: 10_000, startDate: utcDay(0),
  });
  h["removedUser"] = removed.userId;

  // Non-Saving jar statuses, each holding an otherwise-eligible schedule.
  for (const status of ["Draft", "Inviting", "Completed", "Cancelled"]) {
    const u = await user(`st${status.toLowerCase()}`);
    const j = await jar(u.userId, `st${status.toLowerCase()}`, { status });
    const m = await makeMember(j.jarId, u.userId, { role: "organizer" });
    await makeSchedule(j.jarId, m, { frequency: "weekly", amountCents: 10_000, startDate: utcDay(0) });
    // …and a cutoff and an unaccepted agreement, so all three families are
    // excluded on jar status rather than only the schedule family.
    await pool.query(`update jars set cutoff_date = $2::date where id = $1`, [j.jarId, utcDay(0)]);
    await makeAgreement(j.jarId);
    h[`status${status}User`] = u.userId;
    h[`status${status}Jar`] = j.jarId;
  }

  // Profile-less user — the old loop's `if (!profile) continue`.
  const noProfile = await makeProfilelessUser(FIXTURES, "noprofile");
  userIds.push(noProfile.userId);
  const noProfileJar = await jar(noProfile.userId, "noprofilejar", { cutoffDate: utcDay(0) });
  const noProfileMember = await makeMember(noProfileJar.jarId, noProfile.userId, { role: "organizer" });
  await makeSchedule(noProfileJar.jarId, noProfileMember, {
    frequency: "weekly", amountCents: 10_000, startDate: utcDay(0),
  });
  await makeAgreement(noProfileJar.jarId);
  h["noProfileUser"] = noProfile.userId;

  // Preference disabled — the event and notification still happen; the email does not.
  const prefOff = await user("prefoff", { contributionReminders: false });
  const prefOffJar = await jar(prefOff.userId, "prefoffjar");
  const prefOffMember = await makeMember(prefOffJar.jarId, prefOff.userId, { role: "organizer" });
  h["prefOffSchedule"] = await makeSchedule(prefOffJar.jarId, prefOffMember, {
    frequency: "weekly", amountCents: 10_000, startDate: utcDay(0),
  });
  h["prefOffUser"] = prefOff.userId;

  // ── Cutoff reminders ──────────────────────────────────────────────────────
  //
  // One jar per offset, on both sides of all three windows.

  for (const offset of [-5, 0, 1, 2, 6, 7, 8]) {
    const label = offset < 0 ? `cutm${-offset}` : `cutp${offset}`;
    const u = await user(label);
    const j = await jar(u.userId, label, { cutoffDate: utcDay(offset) });
    await makeMember(j.jarId, u.userId, { role: "organizer" });
    h[`${label}User`] = u.userId;
    h[`${label}Jar`] = j.jarId;
    h[`${label}JarName`] = j.jarName;
    h[`${label}Cutoff`] = utcDay(offset);
  }

  // Cutoff reached, two members: one active, one removed. Recipient scoping.
  const org = await user("scopeorg");
  const active = await user("scopeactive");
  const gone = await user("scopegone");
  const scopeJar = await jar(org.userId, "scopejar", { cutoffDate: utcDay(-1) });
  await makeMember(scopeJar.jarId, org.userId, { role: "organizer" });
  await makeMember(scopeJar.jarId, active.userId);
  await makeMember(scopeJar.jarId, gone.userId, { status: "removed" });
  h["scopeOrgUser"] = org.userId;
  h["scopeActiveUser"] = active.userId;
  h["scopeGoneUser"] = gone.userId;
  h["scopeJar"] = scopeJar.jarId;
  h["scopeJarName"] = scopeJar.jarName;
  h["scopeCutoff"] = utcDay(-1);

  // Identical cutoff, three different jar timezones. The reminder windows are
  // UTC-derived, so all three must behave identically — Jar Time governs
  // AutoDrip scheduling, never reminder windows.
  for (const [label, zone] of [
    ["tzauck", "Pacific/Auckland"],
    ["tznyc", "America/New_York"],
    ["tzutc", "UTC"],
  ] as const) {
    const u = await user(label);
    const j = await jar(u.userId, label, { cutoffDate: utcDay(1), timeZone: zone });
    await makeMember(j.jarId, u.userId, { role: "organizer" });
    h[`${label}User`] = u.userId;
    h[`${label}Jar`] = j.jarId;
  }

  // ── Agreement reminders ───────────────────────────────────────────────────

  // Unaccepted agreement.
  const agr = await user("agr");
  const agrJar = await jar(agr.userId, "agrjar");
  await makeMember(agrJar.jarId, agr.userId, { role: "organizer" });
  h["agrAgreement"] = await makeAgreement(agrJar.jarId, { version: "2.1" });
  h["agrUser"] = agr.userId;
  h["agrJar"] = agrJar.jarId;
  h["agrJarName"] = agrJar.jarName;

  // Accepted agreement.
  const acc = await user("acc");
  const accJar = await jar(acc.userId, "accjar");
  await makeMember(accJar.jarId, acc.userId, { role: "organizer" });
  const accAgreement = await makeAgreement(accJar.jarId);
  await acceptAgreement(accAgreement, acc.userId);
  h["accUser"] = acc.userId;

  // No agreement at all.
  const noAgr = await user("noagr");
  const noAgrJar = await jar(noAgr.userId, "noagrjar");
  await makeMember(noAgrJar.jarId, noAgr.userId, { role: "organizer" });
  h["noAgrUser"] = noAgr.userId;

  // Two versions; the old one accepted. The current (newest) one is not.
  const superseded = await user("superseded");
  const supJar = await jar(superseded.userId, "supjar");
  await makeMember(supJar.jarId, superseded.userId, { role: "organizer" });
  const oldAgreement = await makeAgreement(supJar.jarId, {
    version: "1.0", createdAt: new Date(Date.now() - 86_400_000),
  });
  await acceptAgreement(oldAgreement, superseded.userId);
  h["supersededOld"] = oldAgreement;
  h["supersededNew"] = await makeAgreement(supJar.jarId, { version: "2.0" });
  h["supersededUser"] = superseded.userId;
  h["supersededJar"] = supJar.jarId;

  return { userIds, jarIds, h };
}

// ─── The oracle: the pre-M3 algorithm, transcribed ───────────────────────────

/**
 * Reproduce the pre-M3 processor's candidate selection, row at a time, and
 * return the event keys it would have produced — scoped to `jarIds`.
 *
 * Deliberately written the way the old code was: fetch, loop, look each thing
 * up individually, `continue` on a miss. It is slow and that is fine; it runs
 * over one file's fixtures, not a database.
 */
async function preM3ExpectedEventKeys(jarIds: string[], now: Date): Promise<string[]> {
  const keys: string[] = [];
  const todayUTC = toUTCDateString(now);
  const q = async <T>(text: string, params: unknown[]): Promise<T[]> =>
    (await pool.query(text, params)).rows as T[];

  // ── 1. schedules ──
  const schedules = await q<{
    id: string; jar_id: string; member_id: string; frequency: string;
    amount_cents: number; start_date: string; preferred_day: number | null;
  }>(
    `select id, jar_id, member_id, frequency, amount_cents,
            to_char(start_date, 'YYYY-MM-DD') as start_date, preferred_day
       from contribution_schedules
      where is_active = true and is_paused = false and jar_id = any($1::uuid[])`,
    [jarIds],
  );

  for (const s of schedules) {
    const [member] = await q<{ id: string; user_id: string }>(
      `select id, user_id from jar_members where id = $1 and status = 'active' limit 1`,
      [s.member_id],
    );
    if (!member) continue;
    const [jar] = await q<{ id: string }>(
      `select id from jars where id = $1 and status = 'Saving' limit 1`,
      [s.jar_id],
    );
    if (!jar) continue;
    const [user] = await q<{ email: string }>(`select email from users where id = $1 limit 1`, [member.user_id]);
    if (!user) continue;
    const [profile] = await q<{ user_id: string }>(`select user_id from profiles where user_id = $1 limit 1`, [member.user_id]);
    if (!profile) continue;

    const [{ total }] = await q<{ total: string }>(
      `select coalesce(sum(amount_cents), 0)::text as total
         from contributions
        where member_id = $1 and jar_id = $2 and contribution_date >= $3::date
          and status in ('completed', 'simulated')`,
      [s.member_id, s.jar_id, s.start_date],
    );

    const status = computeScheduleStatus(
      {
        startDate: s.start_date, frequency: s.frequency, preferredDay: s.preferred_day,
        isActive: true, isPaused: false, amountCents: s.amount_cents,
      },
      now,
      Number(total),
    );

    if (status.state === "due_today") keys.push(`contribution_due:${s.id}:${todayUTC}`);
    if (status.state === "missed" && status.outstandingCents > 0) {
      keys.push(`contribution_missed:${s.id}:${todayUTC}`);
    }
  }

  // ── 2. cutoff ──
  const savingJars = await q<{ id: string; cutoff_date: string | null; organizer_id: string }>(
    `select id, to_char(cutoff_date, 'YYYY-MM-DD') as cutoff_date, organizer_id
       from jars where status = 'Saving' and id = any($1::uuid[])`,
    [jarIds],
  );

  for (const jar of savingJars) {
    if (!jar.cutoff_date) continue;
    const daysAway = daysUntil(jar.cutoff_date, now);
    const members = await q<{ user_id: string }>(
      `select user_id from jar_members where jar_id = $1 and status = 'active'`,
      [jar.id],
    );
    for (const m of members) {
      const [user] = await q<{ email: string }>(`select email from users where id = $1 limit 1`, [m.user_id]);
      if (!user) continue;
      const [profile] = await q<{ user_id: string }>(`select user_id from profiles where user_id = $1 limit 1`, [m.user_id]);
      if (!profile) continue;

      if (daysAway === 7) keys.push(`cutoff_upcoming_7d:${jar.id}:${jar.cutoff_date}:${m.user_id}`);
      if (daysAway === 1) keys.push(`cutoff_upcoming_1d:${jar.id}:${jar.cutoff_date}:${m.user_id}`);
      if (daysAway <= 0) keys.push(`cutoff_reached:${jar.id}:${jar.cutoff_date}:${m.user_id}`);
    }
  }

  // ── 3. agreements ──
  for (const jar of savingJars) {
    const [agreement] = await q<{ id: string }>(
      `select id from agreements where jar_id = $1 order by created_at desc, id desc limit 1`,
      [jar.id],
    );
    if (!agreement) continue;
    const members = await q<{ user_id: string }>(
      `select user_id from jar_members where jar_id = $1 and status = 'active'`,
      [jar.id],
    );
    for (const m of members) {
      const [acceptance] = await q<{ id: string }>(
        `select id from agreement_acceptances where agreement_id = $1 and user_id = $2 limit 1`,
        [agreement.id, m.user_id],
      );
      if (acceptance) continue;
      const [user] = await q<{ email: string }>(`select email from users where id = $1 limit 1`, [m.user_id]);
      if (!user) continue;
      const [profile] = await q<{ user_id: string }>(`select user_id from profiles where user_id = $1 limit 1`, [m.user_id]);
      if (!profile) continue;
      keys.push(`agreement_required:${agreement.id}:${m.user_id}`);
    }
  }

  return keys.sort();
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

beforeAll(async () => {
  orphanBaseline = await captureOrphanBaseline();
  process.env["INTERNAL_REMINDER_TOKEN"] = INTERNAL_TOKEN;
  pop = await buildPopulation();
}, 120_000);

afterAll(async () => {
  await teardownFixtures(FIXTURES, {
    baseline: orphanBaseline,
    restore: () => {
      if (originalToken !== undefined) process.env["INTERNAL_REMINDER_TOKEN"] = originalToken;
      else delete process.env["INTERNAL_REMINDER_TOKEN"];
    },
  });
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("M3 — selection parity with the pre-M3 processor", () => {
  let firstRunAt: Date;

  it("emits exactly the event set the pre-M3 algorithm would have", { timeout: 120_000 }, async () => {
    const res = await runProcessor();
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    firstRunAt = new Date(res.body.runAt);

    const expectedKeys = await preM3ExpectedEventKeys(pop.jarIds, firstRunAt);
    const actual = (await reminderEventsFor(pop.userIds)).map((r) => r.eventKey).sort();

    expect(actual).toEqual(expectedKeys);
    // A vacuous pass would be indistinguishable from a broken processor.
    expect(expectedKeys.length).toBeGreaterThan(10);
  });

  it("covers every reminder type at least once", async () => {
    const types = new Set((await reminderEventsFor(pop.userIds)).map((r) => r.eventType));
    expect([...types].sort()).toEqual([
      "agreement_required",
      "contribution_due",
      "contribution_missed",
      "cutoff_reached",
      "cutoff_upcoming",
    ]);
  });

  it("event keys keep their exact pre-M3 format", async () => {
    const events = await reminderEventsFor(pop.userIds);
    const keys = new Set(events.map((e) => e.eventKey));
    const today = toUTCDateString(firstRunAt);

    expect(keys).toContain(`contribution_due:${pop.h["dueSchedule"]}:${today}`);
    expect(keys).toContain(`contribution_missed:${pop.h["missedSchedule"]}:${today}`);
    expect(keys).toContain(
      `cutoff_upcoming_7d:${pop.h["cutp7Jar"]}:${pop.h["cutp7Cutoff"]}:${pop.h["cutp7User"]}`,
    );
    expect(keys).toContain(
      `cutoff_upcoming_1d:${pop.h["cutp1Jar"]}:${pop.h["cutp1Cutoff"]}:${pop.h["cutp1User"]}`,
    );
    expect(keys).toContain(
      `cutoff_reached:${pop.h["cutp0Jar"]}:${pop.h["cutp0Cutoff"]}:${pop.h["cutp0User"]}`,
    );
    expect(keys).toContain(`agreement_required:${pop.h["agrAgreement"]}:${pop.h["agrUser"]}`);
  });
});

describe("M3 — reminder-window boundaries", () => {
  const keysFor = async (userId: string) =>
    (await reminderEventsFor([userId])).map((e) => e.eventKey.split(":")[0]).sort();

  it("cutoff 7 days out fires the 7-day reminder and nothing else", async () => {
    expect(await keysFor(pop.h["cutp7User"]!)).toEqual(["cutoff_upcoming_7d"]);
  });

  it("cutoff 1 day out fires the 1-day reminder and nothing else", async () => {
    expect(await keysFor(pop.h["cutp1User"]!)).toEqual(["cutoff_upcoming_1d"]);
  });

  it("cutoff today fires cutoff_reached", async () => {
    expect(await keysFor(pop.h["cutp0User"]!)).toEqual(["cutoff_reached"]);
  });

  it("cutoff five days ago still fires cutoff_reached", async () => {
    expect(await keysFor(pop.h["cutm5User"]!)).toEqual(["cutoff_reached"]);
  });

  it("cutoff 2 days out is inside the SQL prefilter but outside every window", async () => {
    expect(await keysFor(pop.h["cutp2User"]!)).toEqual([]);
  });

  it("cutoff 6 days out fires nothing", async () => {
    expect(await keysFor(pop.h["cutp6User"]!)).toEqual([]);
  });

  it("cutoff 8 days out is outside the prefilter and fires nothing", async () => {
    expect(await keysFor(pop.h["cutp8User"]!)).toEqual([]);
  });

  it("jar timezone does not shift a reminder window — all three zones behave identically", async () => {
    for (const label of ["tzauck", "tznyc", "tzutc"]) {
      expect(await keysFor(pop.h[`${label}User`]!), label).toEqual(["cutoff_upcoming_1d"]);
    }
  });

  it("due today fires contribution_due; due_soon and satisfied fire nothing", async () => {
    expect(await keysFor(pop.h["dueUser"]!)).toEqual(["contribution_due"]);
    expect(await keysFor(pop.h["soonUser"]!)).toEqual([]);
    expect(await keysFor(pop.h["satisfiedUser"]!)).toEqual([]);
  });

  it("an outstanding obligation fires contribution_missed", async () => {
    expect(await keysFor(pop.h["missedUser"]!)).toEqual(["contribution_missed"]);
  });
});

describe("M3 — exclusions", () => {
  const eventCount = async (userId: string) => (await reminderEventsFor([userId])).length;

  it("paused and inactive schedules are excluded", async () => {
    expect(await eventCount(pop.h["pausedUser"]!)).toBe(0);
    expect(await eventCount(pop.h["inactiveUser"]!)).toBe(0);
  });

  it("a removed member's schedule is excluded", async () => {
    expect(await eventCount(pop.h["removedUser"]!)).toBe(0);
  });

  it("Draft, Inviting, Completed and Cancelled jars are excluded from all three families", async () => {
    for (const status of ["Draft", "Inviting", "Completed", "Cancelled"]) {
      expect(await eventCount(pop.h[`status${status}User`]!), status).toBe(0);
    }
  });

  it("a user with no profile is excluded from all three families", async () => {
    expect(await eventCount(pop.h["noProfileUser"]!)).toBe(0);
  });

  it("an accepted agreement produces no agreement reminder", async () => {
    expect(await eventCount(pop.h["accUser"]!)).toBe(0);
  });

  it("a jar with no agreement produces no agreement reminder", async () => {
    expect(await eventCount(pop.h["noAgrUser"]!)).toBe(0);
  });

  it("accepting a superseded version still requires the current one", async () => {
    const events = await reminderEventsFor([pop.h["supersededUser"]!]);
    expect(events.map((e) => e.eventKey)).toEqual([
      `agreement_required:${pop.h["supersededNew"]}:${pop.h["supersededUser"]}`,
    ]);
  });
});

describe("M3 — recipient scoping", () => {
  it("a cutoff reminder reaches every active member and no one else", async () => {
    const jarId = pop.h["scopeJar"]!;
    const cutoff = pop.h["scopeCutoff"]!;

    for (const key of ["scopeOrgUser", "scopeActiveUser"]) {
      const events = await reminderEventsFor([pop.h[key]!]);
      expect(events.map((e) => e.eventKey), key).toEqual([
        `cutoff_reached:${jarId}:${cutoff}:${pop.h[key]}`,
      ]);
    }

    expect(await reminderEventsFor([pop.h["scopeGoneUser"]!])).toEqual([]);
  });

  it("every emitted event is addressed to a member of the jar it names", async () => {
    const events = await reminderEventsFor(pop.userIds);
    const memberships: string[] = (
      await pool.query(
        `select jar_id || ':' || user_id as k from jar_members
          where jar_id = any($1::uuid[]) and status = 'active'`,
        [pop.jarIds],
      )
    ).rows.map((r: { k: string }) => r.k);
    for (const e of events) {
      expect(memberships, e.eventKey).toContain(`${e.jarId}:${e.userId}`);
    }
  });
});

describe("M3 — canonical side effects", () => {
  it("emits exactly one in-app notification per canonical event, with unchanged content", async () => {
    const events = await reminderEventsFor(pop.userIds);
    const notes = await notificationsFor(pop.userIds);
    expect(notes.length).toBe(events.length);

    const due = notes.find((n) => n.userId === pop.h["dueUser"]);
    expect(due).toMatchObject({
      type: "contribution_due",
      title: "Contribution Due Today",
      message: `Your $100 contribution to ${pop.h["dueJarName"]} is due today.`,
      relatedJarId: pop.h["dueJar"],
      actionUrl: `/jar/${pop.h["dueJar"]}`,
    });

    const missed = notes.find((n) => n.userId === pop.h["missedUser"]);
    expect(missed).toMatchObject({
      type: "contribution_missed",
      title: "Contribution Outstanding",
      message:
        `You have $300 outstanding in ${pop.h["missedJarName"]}. ` +
        `Add a contribution to catch up.`,
      relatedJarId: pop.h["missedJar"],
    });

    const sevenDay = notes.find((n) => n.userId === pop.h["cutp7User"]);
    expect(sevenDay).toMatchObject({
      type: "cutoff_upcoming",
      title: `${pop.h["cutp7JarName"]} commitment date in 7 days`,
      message:
        `The commitment date for ${pop.h["cutp7JarName"]} is ${pop.h["cutp7Cutoff"]}. ` +
        `Ensure your agreement is accepted and contributions are current.`,
    });

    const oneDay = notes.find((n) => n.userId === pop.h["cutp1User"]);
    expect(oneDay).toMatchObject({
      type: "cutoff_upcoming",
      title: `${pop.h["cutp1JarName"]} commitment date tomorrow`,
    });

    const reached = notes.find((n) => n.userId === pop.h["cutp0User"]);
    expect(reached).toMatchObject({
      type: "cutoff_reached",
      title: `${pop.h["cutp0JarName"]} has entered the Commitment phase`,
      message:
        `${pop.h["cutp0JarName"]} reached its commitment date on ${pop.h["cutp0Cutoff"]} ` +
        `and is now in the Commitment phase. Schedules are locked; contributions remain open.`,
    });

    const agreement = notes.find((n) => n.userId === pop.h["agrUser"]);
    expect(agreement).toMatchObject({
      type: "agreement_required",
      title: `Action needed: ${pop.h["agrJarName"]} savings agreement`,
    });
    expect(agreement?.message).toContain("(v2.1)");
  });

  it("a disabled preference still records the event and the notification, but no email", async () => {
    const events = await reminderEventsFor([pop.h["prefOffUser"]!]);
    expect(events).toHaveLength(1);
    expect(events[0]!.emailStatus).toBe("skipped_preference");
    expect(events[0]!.emailSentAt).toBeNull();
    expect(await notificationsFor([pop.h["prefOffUser"]!])).toHaveLength(1);
  });

  it("every enabled recipient's event reached 'sent' on one attempt", async () => {
    const events = await reminderEventsFor(pop.userIds);
    const sent = events.filter((e) => e.emailStatus === "sent");
    expect(sent.length).toBe(events.length - 1); // all but the prefOff event
    for (const e of sent) {
      expect(e.emailAttemptCount, e.eventKey).toBe(1);
      expect(e.emailSentAt, e.eventKey).not.toBeNull();
    }
  });

  it("the organizer's commitment-phase activity entry is still written", async () => {
    const res = await pool.query(
      `select count(*)::int c from activity_events
        where jar_id = $1 and event_type = 'jar_commitment_phase'`,
      [pop.h["scopeJar"]],
    );
    expect(res.rows[0].c).toBeGreaterThanOrEqual(1);
  });

  it("a processor run creates no contribution, financial transaction, ledger transaction or entry", async () => {
    const before = await financialFootprintFor(pop.jarIds);
    const res = await runProcessor();
    expect(res.status).toBe(200);
    expect(await financialFootprintFor(pop.jarIds)).toEqual(before);
  });
});

describe("M3 — idempotency across runs", () => {
  it("a second run adds no event and no notification, and reports them as duplicates", async () => {
    const eventsBefore = await reminderEventsFor(pop.userIds);
    const notesBefore = await notificationsFor(pop.userIds);

    const res = await runProcessor();
    expect(res.status).toBe(200);

    const eventsAfter = await reminderEventsFor(pop.userIds);
    const notesAfter = await notificationsFor(pop.userIds);

    expect(eventsAfter).toEqual(eventsBefore);
    expect(notesAfter.length).toBe(notesBefore.length);
    // Every one of this file's events is terminal, so each is counted as a
    // duplicate. Other files' candidates may add to this, never subtract.
    expect(res.body.skippedDuplicate).toBeGreaterThanOrEqual(eventsBefore.length);
  });

  it("a sent event is never sent again — attempt count and timestamp are frozen", async () => {
    const before = await reminderEventsFor(pop.userIds);
    await runProcessor();
    const after = await reminderEventsFor(pop.userIds);
    for (const [i, e] of after.entries()) {
      expect(e.emailAttemptCount, e.eventKey).toBe(before[i]!.emailAttemptCount);
      expect(e.emailSentAt?.getTime(), e.eventKey).toBe(before[i]!.emailSentAt?.getTime());
    }
  });
});

describe("M3 — read-only routes have no reminder side effects", () => {
  it("list, dashboard and history reads create no reminder event or notification", async () => {
    const login = await request(app).post(`${BASE}/auth/register`).send({
      email: FIXTURES.email("reader"),
      password: "P@ssword1!",
      firstName: "Read",
      lastName: "Only",
    });
    expect(login.status).toBe(201);
    const token = login.body.token as string;
    const userId = login.body.user.id as string;

    const auth = { Authorization: `Bearer ${token}` };
    const jar = await request(app).post(`${BASE}/jars`).set(auth).send({
      name: FIXTURES.name("Reader Jar"),
      category: "Vacation",
      targetDate: utcDay(400),
      goalAmountCents: 100_000,
    });
    expect(jar.status).toBe(201);
    await request(app).post(`${BASE}/jars/${jar.body.id}/launch`).set(auth);

    const eventsBefore = await reminderEventsFor([userId]);
    const notesBefore = await notificationsFor([userId]);

    for (const path of [
      `/jars`,
      `/jars/${jar.body.id}`,
      `/jars/${jar.body.id}/members`,
      `/jars/${jar.body.id}/schedule`,
      `/jars/${jar.body.id}/agreements`,
      `/jars/${jar.body.id}/agreements/status`,
      `/jars/${jar.body.id}/activity`,
      `/jars/${jar.body.id}/contributions`,
      `/dashboard`,
      `/me/jars`,
      `/me/contributions`,
      `/notifications`,
      `/notifications/unread-count`,
      `/activity`,
      `/auth/preferences`,
    ]) {
      const res = await request(app).get(`${BASE}${path}`).set(auth);
      // A 404 from a resource this jar has none of is still a read. What must
      // never happen is a server error, or a side effect.
      expect(res.status, path).toBeLessThan(500);
    }

    expect(await reminderEventsFor([userId])).toEqual(eventsBefore);
    expect(await notificationsFor([userId])).toEqual(notesBefore);
  }, 60_000);
});
