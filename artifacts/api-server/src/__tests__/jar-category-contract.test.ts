/**
 * Jar category contract — pre-commit remediation item 2.
 *
 * ─── STRICT ON WRITE, TOLERANT ON READ ───────────────────────────────────────
 *
 * These are two decisions, not one, and conflating them breaks something either
 * way.
 *
 * Enforcing the canonical list on READ would break jars that work today: 82
 * rows in the development database carry the legacy free-text value 'travel',
 * plus one 'Other', and they predate the list. Rejecting or erroring on them
 * would take working jars offline to satisfy a contract written afterwards.
 *
 * Not enforcing it on WRITE leaves the column open forever: any client, now or
 * later, can invent a category the UI has never heard of, and the set of
 * oddities grows without bound. The mobile fallback would keep the app
 * rendering, but it would be papering over an ongoing leak rather than a
 * closed historical one.
 *
 * So: rejected on write, tolerated on read, and the OpenAPI contract says
 * exactly that — `CreateJarRequest.category` is a closed enum while
 * `Jar.category` is a documented open string. A generated client typed as a
 * union over read responses would be lying about its own data.
 *
 * There is deliberately NO database CHECK constraint. It could not be applied
 * without either failing on the existing rows or rewriting them.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import request from "supertest";
import { db, jars, users } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import app from "../app.js";
import { JAR_CATEGORIES } from "../lib/validation.js";

const WORKSPACE_ROOT = join(__dirname, "../../../..");
const MOBILE_CATEGORIES_PATH = join(WORKSPACE_ROOT, "artifacts/mobile/lib/jar-categories.ts");
const OPENAPI_PATH = join(WORKSPACE_ROOT, "lib/api-spec/openapi.yaml");

const unique = () => `cat-${Date.now()}-${Math.random().toString(36).slice(2)}`;

let token: string;
let userId: string;

beforeAll(async () => {
  const res = await request(app).post("/api/auth/register").send({
    email: `${unique()}@example.com`,
    password: "password123",
    firstName: "Cat",
    lastName: "Test",
  });
  expect(res.status).toBe(201);
  token = res.body.token as string;
  userId = res.body.user.id as string;
});

async function createJarWithCategory(category: unknown) {
  return request(app)
    .post("/api/jars")
    .set("Authorization", `Bearer ${token}`)
    .send({
      name: `Category ${unique()}`,
      category,
      goalAmountCents: 100_000,
      targetDate: new Date(Date.now() + 200 * 86_400_000).toISOString().slice(0, 10),
    });
}

// ─── The list itself ─────────────────────────────────────────────────────────

describe("the canonical list agrees across all three definitions", () => {
  it("has exactly fifteen unique categories", () => {
    expect(JAR_CATEGORIES).toHaveLength(15);
    expect(new Set(JAR_CATEGORIES).size).toBe(15);
  });

  it("matches the mobile catalogue", () => {
    // Read from disk rather than imported: the API package does not depend on
    // the mobile package. Same approach as brand-guard.test.ts.
    const source = readFileSync(MOBILE_CATEGORIES_PATH, "utf-8");
    const start = source.indexOf("CATEGORY_CONFIGS");
    expect(start).toBeGreaterThan(-1);
    const ids = [...source.slice(start).matchAll(/^\s*id: '([A-Za-z]+)',$/gm)].map((m) => m[1]!);

    expect([...new Set(ids)].sort()).toEqual([...JAR_CATEGORIES].sort());
  });

  it("matches the CreateJarRequest enum in the OpenAPI spec", () => {
    const spec = readFileSync(OPENAPI_PATH, "utf-8");
    const marker = spec.indexOf("CreateJarRequest:");
    expect(marker).toBeGreaterThan(-1);
    const enumLine = /enum: \[([^\]]+)\]/.exec(spec.slice(marker));
    expect(enumLine).not.toBeNull();
    const values = enumLine![1]!.split(",").map((v) => v.trim());

    expect(values.sort()).toEqual([...JAR_CATEGORIES].sort());
  });

  it("leaves Jar.category as an open string on read", () => {
    // A closed enum here would state something false — the server genuinely
    // returns legacy values outside the list.
    const spec = readFileSync(OPENAPI_PATH, "utf-8");
    const jarSchema = spec.slice(spec.indexOf("\n    Jar:\n"), spec.indexOf("\n    JarMember"));
    const categoryBlock = jarSchema.slice(jarSchema.indexOf("category:"), jarSchema.indexOf("description:"));
    expect(categoryBlock).not.toMatch(/enum: \[/);
  });
});

// ─── Write path ──────────────────────────────────────────────────────────────

describe("create accepts every approved category", () => {
  for (const category of JAR_CATEGORIES) {
    it(`accepts ${category}`, async () => {
      const res = await createJarWithCategory(category);
      expect(res.status).toBe(201);
      expect(res.body.category).toBe(category);
    });
  }
});

describe("create rejects anything outside the approved list", () => {
  const rejected: Array<[string, unknown]> = [
    ["the legacy free-text value", "travel"],
    ["a plausible but uncatalogued value", "GroupTrip"],
    ["wrong case", "vacation"],
    ["the empty string", ""],
    ["a number", 42],
    ["null", null],
    ["an object", { id: "Vacation" }],
  ];

  for (const [label, value] of rejected) {
    it(`rejects ${label}`, async () => {
      const res = await createJarWithCategory(value);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("ValidationError");
      expect(res.body.fields.category).toMatch(/category must be one of/);
    });
  }

  it("names the permitted values in the error, so the fix is obvious", async () => {
    const res = await createJarWithCategory("Sabbatical");
    expect(res.body.fields.category).toContain("Vacation");
    expect(res.body.fields.category).toContain("EmergencyFund");
  });

  it("writes nothing when the category is rejected", async () => {
    const before = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(jars)
      .where(eq(jars.organizerId, userId));
    await createJarWithCategory("NotACategory");
    const after = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(jars)
      .where(eq(jars.organizerId, userId));

    expect(after[0]!.n).toBe(before[0]!.n);
  });

  it("still defaults to Vacation when the field is omitted entirely", async () => {
    // Older clients that never sent a category must keep working.
    const res = await request(app)
      .post("/api/jars")
      .set("Authorization", `Bearer ${token}`)
      .send({
        name: `No Category ${unique()}`,
        goalAmountCents: 100_000,
        targetDate: new Date(Date.now() + 200 * 86_400_000).toISOString().slice(0, 10),
      });
    expect(res.status).toBe(201);
    expect(res.body.category).toBe("Vacation");
  });
});

describe("category is not editable", () => {
  it("PATCH silently ignores a category field rather than writing it", async () => {
    // `category` is absent from the PATCH allowlist and from UpdateJarRequest.
    // Pinned here so widening the allowlist without adding validation cannot
    // pass unnoticed.
    const created = await createJarWithCategory("Vacation");
    expect(created.status).toBe(201);

    const patched = await request(app)
      .patch(`/api/jars/${created.body.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ category: "Definitely Not Valid", name: "Renamed Jar" });
    expect(patched.status).toBe(200);

    const [row] = await db.select().from(jars).where(eq(jars.id, created.body.id));
    expect(row!.category).toBe("Vacation");
    expect(row!.name).toBe("Renamed Jar");
  });
});

// ─── Read path ───────────────────────────────────────────────────────────────

describe("legacy rows outside the list still load", () => {
  let legacyJarId: string;

  beforeAll(async () => {
    // Written directly, as the pre-contract code path would have. This is what
    // 82 rows in the development database look like.
    const [user] = await db
      .insert(users)
      .values({ email: `legacy-${randomUUID()}@test.invalid`, passwordHash: "x", emailVerified: true })
      .returning();

    const [jar] = await db
      .insert(jars)
      .values({
        organizerId: user!.id,
        name: "Legacy Category Jar",
        slug: `legacy-${randomUUID()}`,
        category: "travel",
        targetDate: "2030-12-31",
        goalAmountCents: 100_000,
        currency: "USD",
        status: "Saving",
      })
      .returning();
    legacyJarId = jar!.id;
  });

  it("returns the stored value verbatim rather than erroring or rewriting it", async () => {
    const [row] = await db.select().from(jars).where(eq(jars.id, legacyJarId));
    expect(row!.category).toBe("travel");
  });

  it("has no database constraint that would have blocked the insert", async () => {
    // Deliberate: a CHECK could not be applied to the existing data. Enforcement
    // lives at the request-validation layer instead.
    const constraints = await db.execute(
      sql`SELECT conname FROM pg_constraint WHERE conname LIKE '%jars%categor%'`,
    );
    expect(constraints.rows).toHaveLength(0);
  });

  it("still constrains the precision column, which has no legacy problem", async () => {
    // The contrast is the point: a new column CAN carry a constraint.
    const constraints = await db.execute(
      sql`SELECT conname FROM pg_constraint WHERE conname = 'jars_target_date_precision_check'`,
    );
    expect(constraints.rows).toHaveLength(1);
  });
});
