/**
 * Owner-QA reset — safety guards and destructive behaviour.
 *
 * The tool under test deletes rows. Every test here therefore builds its own
 * throwaway fixtures under a unique `@dripjar.dev` address and passes that
 * address through the `approvedEmails` seam, so nothing can reach a seeded
 * account even if a predicate is wrong. The guard tests run without touching
 * the database at all.
 *
 * `scripts/` has no test runner of its own and adding one would mean installing
 * packages, so the suite lives here — the API server already has vitest, the
 * same database, and the same workspace aliases.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { pool } from "@workspace/db";
import {
  checkGuards,
  runReset,
  buildManifest,
  DELETE_PLAN,
  APPROVED_SYNTHETIC_EMAILS,
  APPROVED_DATABASES,
} from "../lib/owner-reset.js";

const LOCAL_URL = "postgresql://u:p@localhost:5432/dripjar_dev";
const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

// ─── Guards (no database) ────────────────────────────────────────────────────

describe("reset guards", () => {
  const base = { nodeEnv: "development", databaseUrl: LOCAL_URL };

  it("requires an explicit target email", () => {
    const r = checkGuards({ ...base, email: "" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.code).toBe("MISSING_EMAIL");
  });

  it("refuses production", () => {
    const r = checkGuards({ ...base, nodeEnv: "production", email: "jordan@dripjar.dev" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.code).toBe("PRODUCTION_ENV");
  });

  it("refuses a non-local database host", () => {
    for (const host of ["db.example.com", "10.0.0.5", "prod-db.internal", "neon.tech"]) {
      const r = checkGuards({
        ...base,
        databaseUrl: `postgresql://u:p@${host}:5432/dripjar_dev`,
        email: "jordan@dripjar.dev",
      });
      expect(r.ok, `host ${host} must be refused`).toBe(false);
      if (!r.ok) expect(r.failure.code).toBe("NON_LOCAL_HOST");
    }
  });

  it("refuses an unknown database even on localhost", () => {
    for (const db of ["dripjar_prod", "postgres", "dripjar", "dripjar_dev_backup"]) {
      const r = checkGuards({
        ...base,
        databaseUrl: `postgresql://u:p@localhost:5432/${db}`,
        email: "jordan@dripjar.dev",
      });
      expect(r.ok, `database ${db} must be refused`).toBe(false);
      if (!r.ok) expect(r.failure.code).toBe("UNKNOWN_DATABASE");
    }
    expect(APPROVED_DATABASES).toEqual(["dripjar_dev"]);
  });

  it("refuses a non-synthetic email domain", () => {
    for (const email of [
      "jordanbarrett777@gmail.com",
      "someone@thedripjar.com",
      "attacker@dripjar.dev.evil.com",
      "jordan@dripjar.com",
    ]) {
      const r = checkGuards({ ...base, email });
      expect(r.ok, `${email} must be refused`).toBe(false);
      if (!r.ok) expect(r.failure.code).toBe("EMAIL_NOT_APPROVED");
    }
  });

  it("allowlists by exact address, not by domain suffix", () => {
    // A brand-new @dripjar.dev address is NOT automatically resettable.
    const r = checkGuards({ ...base, email: `nobody-${unique()}@dripjar.dev` });
    expect(r.ok).toBe(false);
    expect(APPROVED_SYNTHETIC_EMAILS).toContain("jordan@dripjar.dev");
  });

  it("accepts the approved owner against the local QA database", () => {
    const r = checkGuards({ ...base, email: "jordan@dripjar.dev" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.db).toEqual({ host: "localhost", port: "5432", database: "dripjar_dev" });
  });

  it("never echoes the connection string or its password in a failure message", () => {
    const r = checkGuards({
      ...base,
      databaseUrl: "postgresql://someuser:sup3rs3cret@db.example.com:5432/dripjar_dev",
      email: "jordan@dripjar.dev",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failure.message).not.toContain("sup3rs3cret");
      expect(r.failure.message).not.toContain("someuser");
      expect(r.failure.message).not.toContain("postgresql://");
    }
  });

  it("deletes jars last, and breaks the ledger cycle before deleting either side", () => {
    const labels = DELETE_PLAN.map((s) => s.label);
    expect(labels[labels.length - 1]).toBe("jars");
    const nullLedger = labels.indexOf("financial_transactions.ledger_id := null");
    expect(nullLedger).toBeGreaterThan(-1);
    expect(nullLedger).toBeLessThan(labels.indexOf("ledger_transactions"));
    expect(labels.indexOf("ledger_entries")).toBeLessThan(labels.indexOf("ledger_transactions"));
    expect(labels.indexOf("ledger_transactions")).toBeLessThan(labels.indexOf("financial_transactions"));
    // Every RESTRICT child of jars must precede the jar delete.
    for (const t of ["financial_transactions", "fund_commitments", "refund_requests", "autodrip_authorizations"]) {
      expect(labels.indexOf(t), `${t} must be deleted before jars`).toBeLessThan(labels.indexOf("jars"));
    }
  });
});

// ─── Destructive behaviour, against throwaway fixtures ───────────────────────

interface Fixture {
  targetEmail: string;
  targetId: string;
  otherId: string;
  ownedJarId: string;
  foreignJarId: string;
  unrelatedJarId: string;
}

async function q(sql: string, params: unknown[] = []) {
  return (await pool.query(sql, params)).rows;
}

/**
 * Target owns one jar (with members, agreement, acceptance, milestone,
 * notification, activity). A second synthetic user owns a jar the target is
 * merely a member of, plus an unrelated jar the target has nothing to do with.
 */
async function buildFixture(): Promise<Fixture> {
  const u = unique();
  const targetEmail = `reset-target-${u}@dripjar.dev`;
  const [target] = await q(`insert into users (email, email_verified, password_hash) values ($1, true, 'hash-target') returning id`, [targetEmail]);
  const [other] = await q(`insert into users (email, email_verified, password_hash) values ($1, true, 'hash-other') returning id`, [`reset-other-${u}@dripjar.dev`]);
  await q(`insert into profiles (user_id, first_name, last_name, display_name) values ($1,'Reset','Target','Reset Target')`, [target.id]);
  await q(`insert into profiles (user_id, first_name, last_name, display_name) values ($1,'Reset','Other','Reset Other')`, [other.id]);

  const mkJar = async (owner: string, name: string) =>
    (await q(
      `insert into jars (organizer_id, name, slug, target_date, goal_amount_cents, status)
       values ($1,$2,$3,'2027-01-01',100000,'Draft') returning id`,
      [owner, name, `${name}-${u}`],
    ))[0].id as string;

  const ownedJarId = await mkJar(target.id, "owned");
  const foreignJarId = await mkJar(other.id, "foreign");
  const unrelatedJarId = await mkJar(other.id, "unrelated");

  await q(`insert into jar_members (jar_id, user_id, role) values ($1,$2,'organizer')`, [ownedJarId, target.id]);
  await q(`insert into jar_members (jar_id, user_id, role) values ($1,$2,'member')`, [ownedJarId, other.id]);
  await q(`insert into jar_members (jar_id, user_id, role) values ($1,$2,'member')`, [foreignJarId, target.id]);
  await q(`insert into jar_members (jar_id, user_id, role) values ($1,$2,'organizer')`, [foreignJarId, other.id]);
  await q(`insert into jar_members (jar_id, user_id, role) values ($1,$2,'organizer')`, [unrelatedJarId, other.id]);

  const [ag] = await q(`insert into agreements (jar_id, version, content, effective_date) values ($1,'1.0','fixture terms','2026-01-01') returning id`, [ownedJarId]);
  await q(`insert into agreement_acceptances (agreement_id, user_id) values ($1,$2)`, [ag.id, target.id]);
  await q(`insert into milestones (jar_id, name, target_amount_cents) values ($1,'Fixture MS',50000)`, [ownedJarId]);
  await q(`insert into notifications (user_id, title, message, related_jar_id) values ($1,'t','m',$2)`, [target.id, ownedJarId]);
  await q(`insert into activity_events (jar_id, user_id, event_type, description) values ($1,$2,'jar_created','fixture')`, [ownedJarId, target.id]);

  return { targetEmail, targetId: target.id, otherId: other.id, ownedJarId, foreignJarId, unrelatedJarId };
}

/** Fixtures live outside the allowlist by design, so tear-down is manual. */
async function destroyFixture(f: Fixture) {
  const jarIds = [f.ownedJarId, f.foreignJarId, f.unrelatedJarId];
  await q(`delete from activity_events where jar_id = any($1) or user_id = any($2)`, [jarIds, [f.targetId, f.otherId]]);
  await q(`delete from agreement_acceptances where agreement_id in (select id from agreements where jar_id = any($1)) or user_id = any($2)`, [jarIds, [f.targetId, f.otherId]]);
  await q(`delete from agreements where jar_id = any($1)`, [jarIds]);
  await q(`delete from milestones where jar_id = any($1)`, [jarIds]);
  await q(`delete from notifications where user_id = any($1) or related_jar_id = any($2)`, [[f.targetId, f.otherId], jarIds]);
  await q(`delete from jar_members where jar_id = any($1) or user_id = any($2)`, [jarIds, [f.targetId, f.otherId]]);
  await q(`delete from jars where id = any($1)`, [jarIds]);
  await q(`delete from profiles where user_id = any($1)`, [[f.targetId, f.otherId]]);
  await q(`delete from users where id = any($1)`, [[f.targetId, f.otherId]]);
}

describe("reset execution", () => {
  let f: Fixture;
  const approvedFor = (email: string) => [email];

  beforeAll(async () => { f = await buildFixture(); });
  afterAll(async () => { await destroyFixture(f); });

  it("builds a manifest naming the owned jar and the foreign membership", async () => {
    const client = await pool.connect();
    try {
      const m = await buildManifest(client, f.targetId, f.targetEmail);
      expect(m.ownedJars.map((j) => j.id)).toEqual([f.ownedJarId]);
      expect(m.foreignMemberships.map((x) => x.jarId)).toEqual([f.foreignJarId]);
      expect(m.counts.jars).toBe(1);
      expect(m.counts.agreements).toBe(1);
      expect(m.counts.milestones).toBe(1);
      // 2 members on the owned jar + the target's membership in the foreign jar
      expect(m.counts.jar_members).toBe(3);
    } finally {
      client.release();
    }
  });

  it("dry run writes nothing", async () => {
    const before = await q(`select count(*)::int c from jars where organizer_id=$1`, [f.targetId]);
    const res = await runReset({ email: f.targetEmail, confirm: false, quiet: true, approvedEmails: approvedFor(f.targetEmail) });
    expect(res.reconciliation).toBeUndefined();
    const after = await q(`select count(*)::int c from jars where organizer_id=$1`, [f.targetId]);
    expect(after[0].c).toBe(before[0].c);
    expect(after[0].c).toBe(1);
    expect((await q(`select count(*)::int c from agreements where jar_id=$1`, [f.ownedJarId]))[0].c).toBe(1);
  });

  it("handles a missing target safely", async () => {
    const missing = `reset-missing-${unique()}@dripjar.dev`;
    await expect(
      runReset({ email: missing, confirm: true, quiet: true, approvedEmails: approvedFor(missing) }),
    ).rejects.toThrow(/No user found/);
  });

  it("rolls back completely on an injected failure", async () => {
    await expect(
      runReset({ email: f.targetEmail, confirm: true, quiet: true, injectFailure: true, approvedEmails: approvedFor(f.targetEmail) }),
    ).rejects.toThrow(/Injected failure/);

    // Everything must still be present.
    expect((await q(`select count(*)::int c from jars where organizer_id=$1`, [f.targetId]))[0].c).toBe(1);
    expect((await q(`select count(*)::int c from agreements where jar_id=$1`, [f.ownedJarId]))[0].c).toBe(1);
    expect((await q(`select count(*)::int c from jar_members where user_id=$1`, [f.targetId]))[0].c).toBe(2);
    expect((await q(`select count(*)::int c from notifications where user_id=$1`, [f.targetId]))[0].c).toBe(1);
  });

  it("removes owned jars and dependants, keeps the account, and spares everyone else", async () => {
    const otherBefore = await q(`select id, email, password_hash, email_verified from users where id=$1`, [f.otherId]);

    const res = await runReset({ email: f.targetEmail, confirm: true, quiet: true, approvedEmails: approvedFor(f.targetEmail) });
    const r = res.reconciliation!;

    // Account survives, untouched.
    expect(r.userStillExists).toBe(true);
    expect(r.passwordHashUnchanged).toBe(true);
    expect(r.emailVerifiedUnchanged).toBe(true);
    expect(r.profileStillExists).toBe(true);

    // Owner is empty.
    expect(r.ownedJars).toBe(0);
    expect(r.memberships).toBe(0);
    expect(r.notifications).toBe(0);
    expect(r.activityEvents).toBe(0);

    // Owned jar and its dependants are gone.
    expect((await q(`select count(*)::int c from jars where id=$1`, [f.ownedJarId]))[0].c).toBe(0);
    expect((await q(`select count(*)::int c from agreements where jar_id=$1`, [f.ownedJarId]))[0].c).toBe(0);
    expect((await q(`select count(*)::int c from milestones where jar_id=$1`, [f.ownedJarId]))[0].c).toBe(0);
    expect((await q(`select count(*)::int c from jar_members where jar_id=$1`, [f.ownedJarId]))[0].c).toBe(0);

    // The foreign jar SURVIVES; only the target's membership went.
    expect((await q(`select count(*)::int c from jars where id=$1`, [f.foreignJarId]))[0].c).toBe(1);
    expect((await q(`select count(*)::int c from jar_members where jar_id=$1 and user_id=$2`, [f.foreignJarId, f.targetId]))[0].c).toBe(0);
    expect((await q(`select count(*)::int c from jar_members where jar_id=$1 and user_id=$2`, [f.foreignJarId, f.otherId]))[0].c).toBe(1);

    // The unrelated jar is untouched.
    expect((await q(`select count(*)::int c from jars where id=$1`, [f.unrelatedJarId]))[0].c).toBe(1);

    // The other user is value-for-value unchanged.
    const otherAfter = await q(`select id, email, password_hash, email_verified from users where id=$1`, [f.otherId]);
    expect(otherAfter[0]).toEqual(otherBefore[0]);

    // No dangling financial or ledger rows anywhere.
    expect(r.orphanedLedgerEntries).toBe(0);
    expect(r.orphanedFinancialTransactions).toBe(0);
  });

  it("leaves the reset idempotent — a second run finds nothing to do", async () => {
    const res = await runReset({ email: f.targetEmail, confirm: true, quiet: true, approvedEmails: approvedFor(f.targetEmail) });
    expect(res.manifest.ownedJars).toHaveLength(0);
    expect(res.reconciliation!.ownedJars).toBe(0);
    expect(res.reconciliation!.userStillExists).toBe(true);
  });
});

// ─── Seed separation ─────────────────────────────────────────────────────────

describe("owner seed no longer creates demo jars", () => {
  it("attaches the demonstration fixtures to demo@dripjar.dev, not the owner", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const seed = readFileSync(join(__dirname, "../../../../scripts/src/seed.ts"), "utf-8");

    expect(seed).toContain('email: "demo@dripjar.dev"');
    expect(seed).toContain("organizerId: demo.id");
    // The owner must not organise, join, or be credited with any fixture.
    expect(seed).not.toContain("organizerId: jordan.id");
    expect(seed).not.toMatch(/\{\s*user:\s*jordan,\s*role:/);
    expect(seed).not.toContain("jordan.id");
  });

  it("keeps the owner account itself in the seed", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const seed = readFileSync(join(__dirname, "../../../../scripts/src/seed.ts"), "utf-8");
    expect(seed).toContain('email: "jordan@dripjar.dev"');
  });
});
