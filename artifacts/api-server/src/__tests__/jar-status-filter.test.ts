/**
 * GET /jars status filtering — Owner QA item 10
 *
 * A jar created from the create-jar flow never appeared in My Jars. The
 * organizer membership and the default agreement were both written correctly,
 * so the jar existed and the user had access to it; it simply could not be
 * listed.
 *
 * Root cause: `GET /jars` filtered with exact string equality —
 * `jarList.filter(j => j.status === status)` — while the My Jars "Active" tab
 * sent the comma-separated `"Saving,FullyFunded"`. No stored status equals that
 * string, so Active returned an empty array for EVERY user, not only for users
 * with a new Draft jar. Nothing surfaced the mismatch: an unrecognised filter
 * and a genuinely empty account produced byte-identical responses.
 *
 * These tests pin the properties that make that impossible to reintroduce:
 *
 *   1. a comma-separated filter matches every status it names
 *   2. a single status still works (no regression)
 *   3. a jar's status is never mutated by listing it — Draft stays Draft
 *   4. an unrecognised status is a 400, never a silently empty list
 *   5. an absent or blank filter returns everything in scope, never nothing
 *   6. the filter never widens scope: another user's jars stay invisible
 *
 * Property 4 is the load-bearing one. Properties 1–3 fix today's bug; 4 is what
 * stops the next version of it from being silent.
 */
import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import app from "../app.js";
import { db, jars } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  parseStatusFilter,
  isJarStatus,
  JAR_STATUSES,
} from "../lib/jar-status.js";

const unique = () => `jsf-${Date.now()}-${Math.random().toString(36).slice(2)}`;

async function registerUser() {
  const email = `${unique()}@example.com`;
  const res = await request(app).post("/api/auth/register").send({
    email,
    password: "password123",
    firstName: "Filter",
    lastName: "Tester",
  });
  expect(res.status).toBe(201);
  return { email, token: res.body.token as string, userId: res.body.user.id as string };
}

async function createJar(token: string, name: string) {
  const res = await request(app)
    .post("/api/jars")
    .set("Authorization", `Bearer ${token}`)
    .send({
      name,
      category: "Vacation",
      goalAmountCents: 500_000,
      targetDate: new Date(Date.now() + 180 * 86_400_000).toISOString().slice(0, 10),
    });
  expect(res.status).toBe(201);
  return res.body as { id: string; status: string };
}

/** List jars for `token`, optionally filtered. Returns the raw supertest response. */
function listJars(token: string, status?: string) {
  const req = request(app).get("/api/jars").set("Authorization", `Bearer ${token}`);
  return status === undefined ? req : req.query({ status });
}

const idsOf = (body: unknown[]) => (body as { id: string }[]).map((j) => j.id);

// ─── Pure parsing ────────────────────────────────────────────────────────────

describe("parseStatusFilter", () => {
  it("splits a comma-separated filter into a set", () => {
    const result = parseStatusFilter("Saving,FullyFunded");
    expect(result).toEqual({ ok: true, statuses: ["Saving", "FullyFunded"] });
  });

  it("accepts the repeated-parameter form Express hands over as an array", () => {
    const result = parseStatusFilter(["Saving", "Draft"]);
    expect(result).toEqual({ ok: true, statuses: ["Saving", "Draft"] });
  });

  it("trims whitespace, drops blanks, and collapses duplicates", () => {
    const result = parseStatusFilter(" Saving , , Saving ,Draft,");
    expect(result).toEqual({ ok: true, statuses: ["Saving", "Draft"] });
  });

  it.each([undefined, null, "", "   ", ",,,", []])(
    "treats %p as no filter rather than as an impossible match",
    (input) => {
      // The distinction matters: `statuses: []` would compile to `IN ()` and
      // hide every jar — the exact silent-empty failure this module prevents.
      expect(parseStatusFilter(input)).toEqual({ ok: true, statuses: null });
    },
  );

  it("rejects unknown statuses instead of matching nothing", () => {
    expect(parseStatusFilter("Saving,Bogus,Nonsense")).toEqual({
      ok: false,
      invalid: ["Bogus", "Nonsense"],
    });
  });

  it("is case-sensitive — a near-miss is an error, not an empty result", () => {
    expect(parseStatusFilter("saving")).toEqual({ ok: false, invalid: ["saving"] });
  });

  it("accepts every canonical status", () => {
    for (const status of JAR_STATUSES) {
      expect(isJarStatus(status)).toBe(true);
      expect(parseStatusFilter(status)).toEqual({ ok: true, statuses: [status] });
    }
  });

  it("covers the statuses the app actually writes", () => {
    // Guards against the canonical list drifting from the code that sets
    // statuses: POST /jars writes Draft, launch writes Saving, the fully-funded
    // check writes FullyFunded, and cancel writes Cancelled.
    for (const status of ["Draft", "Saving", "FullyFunded", "Cancelled", "Completed"]) {
      expect(isJarStatus(status)).toBe(true);
    }
  });
});

// ─── Route behaviour ─────────────────────────────────────────────────────────

describe("GET /jars status filtering", () => {
  let owner: Awaited<ReturnType<typeof registerUser>>;
  let stranger: Awaited<ReturnType<typeof registerUser>>;
  let draftJar: { id: string; status: string };
  let savingJar: { id: string; status: string };
  let cancelledJar: { id: string; status: string };

  beforeAll(async () => {
    owner = await registerUser();
    stranger = await registerUser();

    draftJar = await createJar(owner.token, `Draft ${unique()}`);
    savingJar = await createJar(owner.token, `Saving ${unique()}`);
    cancelledJar = await createJar(owner.token, `Cancelled ${unique()}`);

    await request(app)
      .post(`/api/jars/${savingJar.id}/launch`)
      .set("Authorization", `Bearer ${owner.token}`)
      .expect(200);

    await request(app)
      .post(`/api/jars/${cancelledJar.id}/cancel`)
      .set("Authorization", `Bearer ${owner.token}`)
      .expect(200);

    // A jar the owner must never see through any filter.
    await createJar(stranger.token, `Stranger ${unique()}`);
  });

  it("creates jars as Draft and leaves them Draft", async () => {
    // The fix must not paper over the missing jar by auto-promoting it to
    // Saving — that would start a savings schedule nobody agreed to.
    expect(draftJar.status).toBe("Draft");
    const [row] = await db.select().from(jars).where(eq(jars.id, draftJar.id)).limit(1);
    expect(row?.status).toBe("Draft");
  });

  it("returns a newly created Draft jar under the Active filter", async () => {
    // The reported bug, end to end.
    const res = await listJars(owner.token, "Draft,Inviting,Saving,CommitmentPending,Committed,FullyFunded");
    expect(res.status).toBe(200);
    expect(idsOf(res.body)).toEqual(expect.arrayContaining([draftJar.id, savingJar.id]));
    expect(idsOf(res.body)).not.toContain(cancelledJar.id);
  });

  it("matches every status named in a comma-separated filter", async () => {
    const res = await listJars(owner.token, "Saving,FullyFunded");
    expect(res.status).toBe(200);
    // The literal string that used to return nothing.
    expect(idsOf(res.body)).toContain(savingJar.id);
    expect(idsOf(res.body)).not.toContain(draftJar.id);
  });

  it("still honours a single-status filter", async () => {
    const res = await listJars(owner.token, "Cancelled");
    expect(res.status).toBe(200);
    expect(idsOf(res.body)).toEqual([cancelledJar.id]);
  });

  it("returns all of the user's jars when no filter is given", async () => {
    const res = await listJars(owner.token);
    expect(res.status).toBe(200);
    expect(idsOf(res.body)).toEqual(
      expect.arrayContaining([draftJar.id, savingJar.id, cancelledJar.id]),
    );
  });

  it("rejects an unknown status with 400 rather than an empty list", async () => {
    const res = await listJars(owner.token, "Saving,FullyFunded,NotAStatus");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("BadRequest");
    expect(res.body.message).toContain("NotAStatus");
    // The message must name the valid options, so a stale client is diagnosable
    // from the response alone.
    expect(res.body.message).toContain("Draft");
  });

  it("never widens scope — another user's jars stay invisible", async () => {
    const strangerJarIds = idsOf((await listJars(stranger.token)).body);
    const ownerJarIds = idsOf((await listJars(owner.token)).body);
    for (const id of strangerJarIds) {
      expect(ownerJarIds).not.toContain(id);
    }
  });

  it("does not mutate any jar while listing", async () => {
    await listJars(owner.token, "Draft,Inviting,Saving,CommitmentPending,Committed,FullyFunded");
    const rows = await db.select().from(jars).where(eq(jars.id, draftJar.id)).limit(1);
    expect(rows[0]?.status).toBe("Draft");
  });
});
