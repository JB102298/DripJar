/**
 * Seed cleanup — repeatability.
 *
 * `seed.ts` cleared the previous run with `DELETE FROM users`, on the stated
 * assumption that cascades would take the dependants with it. Four of the FKs
 * into `users` are NO ACTION, so the second run raised 23503 and the seed was
 * effectively single-use. Phase 1 moved the demo fixtures onto
 * `demo@dripjar.dev`, which made a re-runnable seed a requirement rather than a
 * nicety.
 *
 * The live `dripjar_dev` seed accounts must not be touched by this suite, so
 * these tests build a seed-SHAPED graph under unique throwaway addresses — an
 * organizer owning a jar with members, agreement, acceptances, milestones,
 * contributions, notifications and activity, exactly the shape `seed.ts`
 * writes — then purge and rebuild it twice.
 */

import { describe, it, expect, afterEach } from "vitest";
import { pool } from "@workspace/db";
import { purgeSyntheticAccounts } from "../lib/owner-reset.js";
import { withGlobalSweepExclusion } from "./support/fixtures.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const q = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows;
const count = async (sql: string, params: unknown[] = []) => Number((await q(sql, params))[0].c);

interface SeedShape {
  emails: string[];
  organizerEmail: string;
  jarId: string;
}

/** Mirrors what `seed.ts` writes: one organizer, four members, one rich jar. */
async function buildSeedShapedRun(tag: string): Promise<SeedShape> {
  const owner = `seedrep-owner-${tag}@dripjar.dev`;
  const organizer = `seedrep-demo-${tag}@dripjar.dev`;
  const members = [`seedrep-a-${tag}@dripjar.dev`, `seedrep-b-${tag}@dripjar.dev`];
  const emails = [owner, organizer, ...members];

  const ids: Record<string, string> = {};
  for (const email of emails) {
    const [u] = await q(`insert into users (email, email_verified, password_hash) values ($1,true,'seed-hash') returning id`, [email]);
    await q(`insert into profiles (user_id, first_name, last_name, display_name) values ($1,'Seed','User',$2)`, [u.id, email]);
    ids[email] = u.id;
  }

  // The owner is created BARE, exactly as the seed now does.
  const jarId = (await q(
    `insert into jars (organizer_id, name, slug, target_date, goal_amount_cents, status)
     values ($1,'Seed Demo Jar',$2,'2027-06-01',1000000,'Saving') returning id`,
    [ids[organizer], `seed-demo-${tag}`],
  ))[0].id as string;

  const memberIds: string[] = [];
  for (const [i, email] of [organizer, ...members].entries()) {
    const [m] = await q(
      `insert into jar_members (jar_id, user_id, role) values ($1,$2,$3) returning id`,
      [jarId, ids[email], i === 0 ? "organizer" : "member"],
    );
    memberIds.push(m.id);
  }

  const [ag] = await q(`insert into agreements (jar_id, version, content, effective_date) values ($1,'2.0','seed terms','2026-01-01') returning id`, [jarId]);
  for (const email of [organizer, ...members]) {
    await q(`insert into agreement_acceptances (agreement_id, user_id) values ($1,$2)`, [ag.id, ids[email]]);
  }

  const [ms] = await q(`insert into milestones (jar_id, name, target_amount_cents) values ($1,'Flights',250000) returning id`, [jarId]);
  const [c] = await q(`insert into contributions (jar_id, member_id, amount_cents, contribution_date) values ($1,$2,50000,'2026-07-01') returning id`, [jarId, memberIds[0]]);
  await q(`insert into milestone_allocations (milestone_id, contribution_id, amount_cents) values ($1,$2,50000)`, [ms.id, c.id]);

  await q(`insert into notifications (user_id, title, message, related_jar_id) values ($1,'seed','seed notice',$2)`, [ids[organizer], jarId]);
  await q(`insert into activity_events (jar_id, user_id, event_type, description) values ($1,$2,'jar_created','seed activity')`, [jarId, ids[organizer]]);

  return { emails, organizerEmail: organizer, jarId };
}

let toClean: string[] = [];
afterEach(async () => {
  if (toClean.length) {
    await withGlobalSweepExclusion(() =>
      purgeSyntheticAccounts(toClean, { approvedEmails: toClean, quiet: true }),
    ).catch(() => {});
    toClean = [];
  }
});

describe("seed cleanup is dependency-aware and repeatable", () => {
  it("the old approach still fails, which is why the refactor was needed", async () => {
    const s = await buildSeedShapedRun(unique());
    toClean = s.emails;

    // Exactly what clearSeedData used to do.
    const [organizer] = await q(`select id from users where email=$1`, [s.organizerEmail]);
    await expect(pool.query(`delete from users where id=$1`, [organizer.id])).rejects.toMatchObject({
      code: "23503",
    });
  });

  it("purges a full seed-shaped run without a foreign-key failure", async () => {
    const s = await buildSeedShapedRun(unique());
    const removed = await withGlobalSweepExclusion(() =>
      purgeSyntheticAccounts(s.emails, { approvedEmails: s.emails, quiet: true }),
    );

    expect(Object.values(removed).every((n) => n === 1)).toBe(true);
    for (const email of s.emails) {
      expect(await count(`select count(*)::int c from users where email=$1`, [email])).toBe(0);
    }
    expect(await count(`select count(*)::int c from jars where id=$1`, [s.jarId])).toBe(0);
    expect(await count(`select count(*)::int c from agreements where jar_id=$1`, [s.jarId])).toBe(0);
    expect(await count(`select count(*)::int c from notifications where related_jar_id=$1`, [s.jarId])).toBe(0);
  });

  it("two consecutive seed-shaped runs produce the same stable result", async () => {
    const tag = unique();

    // Run 1 — build, then clear as the seed does on its next invocation.
    const first = await buildSeedShapedRun(`${tag}-r1`);
    const firstShape = {
      users: first.emails.length,
      jars: await count(`select count(*)::int c from jars where id=$1`, [first.jarId]),
      members: await count(`select count(*)::int c from jar_members where jar_id=$1`, [first.jarId]),
      acceptances: await count(`select count(*)::int c from agreement_acceptances where agreement_id in (select id from agreements where jar_id=$1)`, [first.jarId]),
    };
    await withGlobalSweepExclusion(() =>
      purgeSyntheticAccounts(first.emails, { approvedEmails: first.emails, quiet: true }),
    );

    // Run 2 — the same seed running a second time.
    const second = await buildSeedShapedRun(`${tag}-r2`);
    toClean = second.emails;
    const secondShape = {
      users: second.emails.length,
      jars: await count(`select count(*)::int c from jars where id=$1`, [second.jarId]),
      members: await count(`select count(*)::int c from jar_members where jar_id=$1`, [second.jarId]),
      acceptances: await count(`select count(*)::int c from agreement_acceptances where agreement_id in (select id from agreements where jar_id=$1)`, [second.jarId]),
    };

    expect(secondShape).toEqual(firstShape);
    // The first run left nothing behind.
    expect(await count(`select count(*)::int c from jars where id=$1`, [first.jarId])).toBe(0);
    for (const email of first.emails) {
      expect(await count(`select count(*)::int c from users where email=$1`, [email])).toBe(0);
    }
  });

  it("purging an already-purged run is a no-op rather than an error", async () => {
    const s = await buildSeedShapedRun(unique());
    await withGlobalSweepExclusion(() =>
      purgeSyntheticAccounts(s.emails, { approvedEmails: s.emails, quiet: true }),
    );
    const again = await withGlobalSweepExclusion(() =>
      purgeSyntheticAccounts(s.emails, { approvedEmails: s.emails, quiet: true }),
    );
    expect(Object.values(again).every((n) => n === 0)).toBe(true);
  });

  it("refuses to run cleanup in production", async () => {
    const prev = process.env["NODE_ENV"];
    process.env["NODE_ENV"] = "production";
    try {
      await expect(
        purgeSyntheticAccounts(["jordan@dripjar.dev"], { quiet: true }),
      ).rejects.toThrow(/GUARD:PRODUCTION_ENV/);
    } finally {
      if (prev === undefined) delete process.env["NODE_ENV"];
      else process.env["NODE_ENV"] = prev;
    }
  });

  it("refuses an address outside the synthetic allowlist", async () => {
    await expect(
      purgeSyntheticAccounts(["someone@gmail.com"], { quiet: true }),
    ).rejects.toThrow(/GUARD:EMAIL_NOT_APPROVED/);
  });
});

describe("seed source wiring", () => {
  const seed = () =>
    readFileSync(join(__dirname, "../../../../scripts/src/seed.ts"), "utf-8");

  it("uses the shared purge rather than a second delete order", () => {
    const s = seed();
    expect(s).toContain("purgeSyntheticAccounts");
    // The broken assumption and the bare delete must both be gone. Match an
    // actual call — the doc comment quotes `db.delete(users)` when explaining
    // why it was removed, and that prose is the point, not a regression.
    expect(s).not.toContain("Cascade deletes will handle related records");
    expect(s).not.toMatch(/await\s+db\s*\.delete\(\s*users\s*\)/);
  });

  it("still separates the bare owner from the demo organizer", () => {
    const s = seed();
    expect(s).toContain('email: "jordan@dripjar.dev"');
    expect(s).toContain('email: "demo@dripjar.dev"');
    expect(s).toContain("organizerId: demo.id");
    expect(s).not.toContain("organizerId: jordan.id");
    expect(s).not.toContain("jordan.id");
  });

  it("declares every seed address it is allowed to purge", () => {
    const s = seed();
    expect(s).toContain("SEED_EMAILS");
    for (const e of ["jordan", "demo", "caitlyn", "mom", "dad", "tyler"]) {
      expect(s).toContain(`"${e}@dripjar.dev"`);
    }
  });
});
