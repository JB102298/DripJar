/**
 * Tests for the shared synthetic-fixture hygiene helper.
 *
 * The helper is what other test files now trust to delete rows on their behalf,
 * so its refusals matter more than its deletions: the failure mode worth
 * preventing is not "cleanup missed a row", it is "cleanup removed a row that
 * belonged to someone else". Every guard is therefore exercised directly, and
 * the destructive paths are exercised against fixtures created here and nowhere
 * else.
 *
 * Nothing in this file depends on another test file's rows, and nothing it
 * creates outlives it.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import app from "../app.js";
import { pool } from "@workspace/db";
import { APPROVED_SYNTHETIC_EMAILS } from "../lib/owner-reset.js";
import {
  captureOrphanBaseline,
  checkCleanupTargets,
  createFixtureTag,
  expectTaggedFixturesRemoved,
  FixtureCleanupRefused,
  purgeTaggedFixtures,
  teardownFixtures,
  type FixtureTag,
  type OrphanBaseline,
} from "./support/fixtures.js";

const BASE = "/api";

/** Fixtures owned by this file itself, cleaned up at the end like any other. */
const FIXTURES = createFixtureTag("hygiene");

let orphanBaseline: OrphanBaseline;

beforeAll(async () => {
  orphanBaseline = await captureOrphanBaseline();
});

afterAll(async () => {
  await teardownFixtures(FIXTURES, { baseline: orphanBaseline });
});

const countOf = async (sql: string, params: unknown[] = []) =>
  Number((await pool.query(sql, params)).rows[0].c);

/** Register an account under an arbitrary tag, so scoping can be proven. */
async function registerUnder(tag: FixtureTag, suffix: string) {
  const email = tag.email(suffix);
  const res = await request(app).post(`${BASE}/auth/register`).send({
    email, password: "P@ssword1!", firstName: "Hyg", lastName: "Fixture",
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return { email, token: res.body.token as string, userId: res.body.user.id as string };
}

async function createJarUnder(tag: FixtureTag, token: string) {
  const res = await request(app).post(`${BASE}/jars`).set("Authorization", `Bearer ${token}`).send({
    name: tag.name("Hygiene Jar"),
    category: "Vacation",
    targetDate: "2027-12-31",
    goalAmountCents: 100_000,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as string;
}

// ─── Tag construction ────────────────────────────────────────────────────────

describe("fixture tags", () => {
  it("rejects a prefix that would not survive a LIKE pattern", () => {
    expect(() => createFixtureTag("")).toThrow(/prefix/);
    expect(() => createFixtureTag("A")).toThrow(/prefix/);
    expect(() => createFixtureTag("has-dash")).toThrow(/prefix/);
    expect(() => createFixtureTag("has_underscore")).toThrow(/prefix/);
    expect(() => createFixtureTag("has%percent")).toThrow(/prefix/);
  });

  it("produces LIKE-safe tags with no wildcard or escape characters", () => {
    const tag = createFixtureTag("probe");
    expect(tag.tag).toMatch(/^[a-z][a-z0-9]{11,39}$/);
    expect(tag.tag).not.toMatch(/[%_\\]/);
    expect(tag.emailLike.startsWith("%-")).toBe(true);
    expect(tag.emailLike.endsWith("@test.invalid")).toBe(true);
  });

  it("produces a distinct tag per call, so two files never share a namespace", () => {
    const seen = new Set(Array.from({ length: 50 }, () => createFixtureTag("probe").tag));
    expect(seen.size).toBe(50);
  });

  it("mints unique addresses and names within one tag", () => {
    const tag = createFixtureTag("probe");
    const emails = Array.from({ length: 20 }, () => tag.email("x"));
    expect(new Set(emails).size).toBe(20);
    for (const e of emails) expect(e.endsWith(`-${tag.tag}@test.invalid`)).toBe(true);
    expect(tag.name("Jar")).toContain(tag.tag);
  });
});

// ─── Refusals ────────────────────────────────────────────────────────────────

describe("cleanup refuses anything it does not own", () => {
  const tag = createFixtureTag("refusal").tag;
  const mine = `someone-${tag}@test.invalid`;

  it("accepts a set where every address carries the tag", () => {
    expect(checkCleanupTargets(tag, [mine]).ok).toBe(true);
    expect(checkCleanupTargets(tag, []).ok).toBe(true);
  });

  it("refuses an owner QA account", () => {
    for (const owner of APPROVED_SYNTHETIC_EMAILS) {
      const verdict = checkCleanupTargets(tag, [mine, owner]);
      expect(verdict.ok, `cleanup accepted owner account ${owner}`).toBe(false);
      if (!verdict.ok) expect(verdict.refusal.code).toBe("OWNER_ACCOUNT");
    }
  });

  it("refuses an untagged address, and an address carrying a different tag", () => {
    const otherTag = createFixtureTag("other").tag;
    for (const stranger of [
      "someone@test.invalid",
      "plain@example.com",
      `someone-${otherTag}@test.invalid`,
      `${tag}@test.invalid`,          // tag present but not in the suffix position
      `someone-${tag}@evil.example`,  // right tag, wrong domain
    ]) {
      const verdict = checkCleanupTargets(tag, [stranger]);
      expect(verdict.ok, `cleanup accepted untagged address ${stranger}`).toBe(false);
      if (!verdict.ok) expect(verdict.refusal.code).toBe("UNTAGGED_EMAIL");
    }
  });

  it("refuses a wildcard or too-short tag before any query runs", () => {
    for (const bad of ["", "%", "_", "a", "short", "has-dash-and-more", "UPPER1234567", "%wildcard%"]) {
      const verdict = checkCleanupTargets(bad, []);
      expect(verdict.ok, `cleanup accepted tag "${bad}"`).toBe(false);
      if (!verdict.ok) expect(verdict.refusal.code).toBe("MALFORMED_TAG");
    }
  });

  it("purgeTaggedFixtures throws rather than querying when the tag is malformed", async () => {
    const forged = { tag: "%", emailLike: "%@test.invalid", nameLike: "%", email: () => "", name: () => "" };
    await expect(purgeTaggedFixtures(forged as unknown as FixtureTag)).rejects.toBeInstanceOf(
      FixtureCleanupRefused,
    );
  });
});

// ─── Destructive paths ───────────────────────────────────────────────────────

describe("cleanup removes exactly the tagged fixtures", () => {
  it("cleans a fixture abandoned half-way through setup", async () => {
    // A file whose setup throws after creating the account but before the jar
    // is finished still has rows in the database, and cleanup must find them
    // without being told they exist. Nothing here is passed to the purge — it
    // rediscovers everything from the tag alone.
    const partial = createFixtureTag("partial");
    await registerUnder(partial, "abandoned");
    const second = await registerUnder(partial, "halfbuilt");
    await createJarUnder(partial, second.token);

    // Simulate the throw: no ids are retained past this point.
    expect(
      await countOf(`select count(*)::int c from users where email like $1`, [partial.emailLike]),
    ).toBe(2);
    expect(
      await countOf(`select count(*)::int c from jars where name like $1`, [partial.nameLike]),
    ).toBe(1);

    const removed = await purgeTaggedFixtures(partial);
    expect(removed).toBe(2);
    await expectTaggedFixturesRemoved(partial);
  });

  it("is idempotent — repeated cleanup is a no-op, not an error", async () => {
    const repeat = createFixtureTag("repeat");
    const user = await registerUnder(repeat, "once");
    await createJarUnder(repeat, user.token);

    expect(await purgeTaggedFixtures(repeat)).toBe(1);
    expect(await purgeTaggedFixtures(repeat), "second call must find nothing").toBe(0);
    expect(await purgeTaggedFixtures(repeat), "third call must still be safe").toBe(0);
    await expectTaggedFixturesRemoved(repeat);
  });

  it("leaves another tag's fixtures untouched", async () => {
    const target = createFixtureTag("target");
    const bystander = createFixtureTag("bystand");

    const targetUser = await registerUnder(target, "doomed");
    await createJarUnder(target, targetUser.token);
    const bystanderUser = await registerUnder(bystander, "survivor");
    const bystanderJar = await createJarUnder(bystander, bystanderUser.token);

    await purgeTaggedFixtures(target);
    await expectTaggedFixturesRemoved(target);

    // The bystander is fully intact — account, jar, and membership.
    expect(
      await countOf(`select count(*)::int c from users where email = $1`, [bystanderUser.email]),
    ).toBe(1);
    expect(
      await countOf(`select count(*)::int c from jars where id = $1`, [bystanderJar]),
    ).toBe(1);
    expect(
      await countOf(`select count(*)::int c from jar_members where jar_id = $1`, [bystanderJar]),
    ).toBe(1);

    await purgeTaggedFixtures(bystander);
    await expectTaggedFixturesRemoved(bystander);
  });

  it("never removes an owner QA account, even when one exists alongside the fixtures", async () => {
    // Owner QA accounts are seeded into `dripjar_dev`, not into the disposable
    // test database, so the meaningful assertion is that the tag pattern cannot
    // reach one: it does not match, and if it somehow did, the guard refuses.
    const scoped = createFixtureTag("owners");
    await registerUnder(scoped, "ordinary");

    for (const owner of APPROVED_SYNTHETIC_EMAILS) {
      expect(
        owner.endsWith(`-${scoped.tag}@test.invalid`),
        `owner ${owner} must not match the fixture pattern`,
      ).toBe(false);
      const verdict = checkCleanupTargets(scoped.tag, [owner]);
      expect(verdict.ok).toBe(false);
    }

    const ownerRowsBefore = await countOf(
      `select count(*)::int c from users where email = any($1::text[])`,
      [[...APPROVED_SYNTHETIC_EMAILS]],
    );
    await purgeTaggedFixtures(scoped);
    const ownerRowsAfter = await countOf(
      `select count(*)::int c from users where email = any($1::text[])`,
      [[...APPROVED_SYNTHETIC_EMAILS]],
    );
    expect(ownerRowsAfter, "an owner QA account was removed by test cleanup").toBe(ownerRowsBefore);
  });

  it("does not depend on setup having returned — ids are never required", async () => {
    // The whole contract in one assertion: build fixtures, discard every
    // reference to them, and clean up anyway.
    const blind = createFixtureTag("blind");
    await (async () => {
      const u = await registerUnder(blind, "unreferenced");
      await createJarUnder(blind, u.token);
    })();

    expect(await purgeTaggedFixtures(blind)).toBe(1);
    await expectTaggedFixturesRemoved(blind);
  });
});
