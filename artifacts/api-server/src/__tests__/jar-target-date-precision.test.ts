/**
 * Target-date precision persistence — pre-commit remediation item 1.
 *
 * The precision model was previously create-flow state only. It survived the
 * wizard and then evaporated: reload a year-precision college fund and every
 * screen rendered "January 1, 2044", asserting a day the organizer had
 * explicitly declined to give. A display model that does not survive a reload
 * is not a model, it is a decoration.
 *
 * These tests pin the round trip end to end — request, column, response, edit —
 * plus the three cases that are easy to get wrong:
 *
 *   - an older client that omits the field must land on 'exact', because that
 *     is what every jar created before the column existed was implicitly
 *     asserting, and anything else would silently reinterpret history;
 *   - the stored date must be re-normalised on write, so a coarse jar cannot
 *     carry a day no surface will ever show and no organizer chose;
 *   - an eighteen-year goal must survive creation, reload, and edit intact,
 *     since that is the case the whole model exists for.
 */
import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { db, jars } from "@workspace/db";
import { eq } from "drizzle-orm";
import app from "../app.js";
import { TARGET_DATE_PRECISIONS } from "../lib/validation.js";
import { normalizeTargetDate } from "../lib/target-date.js";

const unique = () => `tdp-${Date.now()}-${Math.random().toString(36).slice(2)}`;

let token: string;

beforeAll(async () => {
  const res = await request(app).post("/api/auth/register").send({
    email: `${unique()}@example.com`,
    password: "password123",
    firstName: "Precision",
    lastName: "Test",
  });
  expect(res.status).toBe(201);
  token = res.body.token as string;
});

async function createJar(body: Record<string, unknown>) {
  return request(app)
    .post("/api/jars")
    .set("Authorization", `Bearer ${token}`)
    .send({
      name: `Precision ${unique()}`,
      goalAmountCents: 500_000,
      ...body,
    });
}

async function getJar(jarId: string) {
  const res = await request(app)
    .get(`/api/jars/${jarId}`)
    .set("Authorization", `Bearer ${token}`);
  expect(res.status).toBe(200);
  return res.body;
}

// ─── Pure normalisation ──────────────────────────────────────────────────────

describe("normalizeTargetDate", () => {
  it("leaves an exact date alone", () => {
    expect(normalizeTargetDate("2044-03-14", "exact")).toBe("2044-03-14");
  });

  it("snaps monthYear to the 1st", () => {
    expect(normalizeTargetDate("2044-03-14", "monthYear")).toBe("2044-03-01");
  });

  it("snaps year to 1 January", () => {
    expect(normalizeTargetDate("2044-03-14", "year")).toBe("2044-01-01");
  });

  it("is idempotent", () => {
    for (const precision of TARGET_DATE_PRECISIONS) {
      const once = normalizeTargetDate("2044-03-14", precision);
      expect(normalizeTargetDate(once, precision)).toBe(once);
    }
  });

  it("operates on the string, never through Date", () => {
    // Routing yyyy-MM-dd through `new Date()` parses UTC midnight, which is the
    // previous day west of Greenwich — this must not shift the year.
    expect(normalizeTargetDate("2044-01-01", "year")).toBe("2044-01-01");
    expect(normalizeTargetDate("2044-12-31", "year")).toBe("2044-01-01");
    expect(normalizeTargetDate("2044-12-31", "monthYear")).toBe("2044-12-01");
  });
});

// ─── Round trip ──────────────────────────────────────────────────────────────

describe("all three precisions round-trip through persistence and the API", () => {
  for (const precision of TARGET_DATE_PRECISIONS) {
    it(`${precision} survives create → column → response`, async () => {
      const res = await createJar({
        category: "Education",
        targetDate: "2044-03-14",
        targetDatePrecision: precision,
      });
      expect(res.status).toBe(201);
      expect(res.body.targetDatePrecision).toBe(precision);

      // The column, not just the response body.
      const [row] = await db.select().from(jars).where(eq(jars.id, res.body.id));
      expect(row!.targetDatePrecision).toBe(precision);

      // And on a fresh read, which is the path a reload takes.
      const reloaded = await getJar(res.body.id);
      expect(reloaded.targetDatePrecision).toBe(precision);
    });
  }

  it("appears on the jar list as well as jar detail", async () => {
    const created = await createJar({
      category: "EmergencyFund",
      targetDate: "2031-06-01",
      targetDatePrecision: "monthYear",
    });
    expect(created.status).toBe(201);

    const list = await request(app).get("/api/jars").set("Authorization", `Bearer ${token}`);
    expect(list.status).toBe(200);
    const summary = list.body.find((j: { id: string }) => j.id === created.body.id);
    expect(summary.targetDatePrecision).toBe("monthYear");
  });
});

// ─── Backward compatibility ──────────────────────────────────────────────────

describe("older clients", () => {
  it("omitting the field stores 'exact' rather than failing", async () => {
    const res = await createJar({ category: "Vacation", targetDate: "2027-06-14" });
    expect(res.status).toBe(201);
    expect(res.body.targetDatePrecision).toBe("exact");

    const [row] = await db.select().from(jars).where(eq(jars.id, res.body.id));
    expect(row!.targetDatePrecision).toBe("exact");
    // An exact jar keeps the exact day it was given.
    expect(row!.targetDate).toBe("2027-06-14");
  });

  it("rejects a precision outside the model with a 400", async () => {
    const res = await createJar({
      category: "Vacation",
      targetDate: "2027-06-14",
      targetDatePrecision: "decade",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("ValidationError");
    expect(res.body.fields.targetDatePrecision).toMatch(/exact, monthYear, year/);
  });
});

// ─── Server-side normalisation ───────────────────────────────────────────────

describe("the stored date is normalised to its precision on write", () => {
  it("stores 1 January for a year-precision jar even when sent a mid-year day", async () => {
    // The mobile picker snaps before sending; the API is public, so the server
    // cannot rely on that. Without this, the jar would carry a day that drives
    // schedule pacing and days-remaining while no surface ever displays it.
    const res = await createJar({
      category: "Education",
      targetDate: "2044-07-19",
      targetDatePrecision: "year",
    });
    expect(res.status).toBe(201);
    expect(res.body.targetDate).toBe("2044-01-01");
  });

  it("stores the 1st for a monthYear jar sent a mid-month day", async () => {
    const res = await createJar({
      category: "Wedding",
      targetDate: "2028-09-23",
      targetDatePrecision: "monthYear",
    });
    expect(res.status).toBe(201);
    expect(res.body.targetDate).toBe("2028-09-01");
  });

  it("validates the cutoff date against the normalised target, not the raw one", async () => {
    // Raw target 2044-07-19 with a cutoff of 2044-03-01 looks fine, but the
    // stored target is 2044-01-01, so the cutoff is actually AFTER it.
    const res = await createJar({
      category: "Education",
      targetDate: "2044-07-19",
      targetDatePrecision: "year",
      cutoffDate: "2044-03-01",
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/before the target date/i);
  });
});

// ─── Editing an existing jar ─────────────────────────────────────────────────

describe("precision is editable wherever the target date is", () => {
  it("changing precision re-normalises the stored date", async () => {
    const created = await createJar({
      category: "Vacation",
      targetDate: "2029-07-19",
      targetDatePrecision: "exact",
    });
    expect(created.status).toBe(201);
    expect(created.body.targetDate).toBe("2029-07-19");

    const patched = await request(app)
      .patch(`/api/jars/${created.body.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ targetDatePrecision: "year" });
    expect(patched.status).toBe(200);

    const reloaded = await getJar(created.body.id);
    expect(reloaded.targetDatePrecision).toBe("year");
    // Coarsening without re-snapping would strand 19 July in the column.
    expect(reloaded.targetDate).toBe("2029-01-01");
  });

  it("changing the date alone snaps it to the precision already on record", async () => {
    const created = await createJar({
      category: "Education",
      targetDate: "2044-01-01",
      targetDatePrecision: "year",
    });
    expect(created.status).toBe(201);

    const patched = await request(app)
      .patch(`/api/jars/${created.body.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ targetDate: "2046-08-30" });
    expect(patched.status).toBe(200);

    const reloaded = await getJar(created.body.id);
    expect(reloaded.targetDatePrecision).toBe("year");
    expect(reloaded.targetDate).toBe("2046-01-01");
  });

  it("rejects an invalid precision on PATCH too", async () => {
    const created = await createJar({ category: "Vacation", targetDate: "2029-07-19" });
    expect(created.status).toBe(201);

    const patched = await request(app)
      .patch(`/api/jars/${created.body.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ targetDatePrecision: "quarter" });
    expect(patched.status).toBe(400);
    expect(patched.body.error).toBe("ValidationError");
  });
});

// ─── The case the model exists for ───────────────────────────────────────────

describe("an eighteen-year, year-precision goal", () => {
  let jarId: string;
  const targetYear = new Date().getFullYear() + 18;

  beforeAll(async () => {
    const res = await createJar({
      name: `Newborn College Fund ${unique()}`,
      category: "Education",
      targetDate: `${targetYear}-01-01`,
      targetDatePrecision: "year",
      goalAmountCents: 12_000_000,
    });
    expect(res.status).toBe(201);
    jarId = res.body.id as string;
  });

  it("survives creation with its precision intact", async () => {
    const jar = await getJar(jarId);
    expect(jar.targetDatePrecision).toBe("year");
    expect(jar.targetDate).toBe(`${targetYear}-01-01`);
  });

  it("survives a reload from the column, not just the create response", async () => {
    const [row] = await db.select().from(jars).where(eq(jars.id, jarId));
    expect(row!.targetDatePrecision).toBe("year");
    expect(row!.targetDate).toBe(`${targetYear}-01-01`);
  });

  it("still reports a usable days-remaining for schedule maths", async () => {
    // The stored value remains a real date, so everything downstream keeps
    // working — the precision governs display only.
    const jar = await getJar(jarId);
    expect(jar.daysRemaining).toBeGreaterThan(365 * 17);
  });

  it("appears in the caller's jar history with its precision", async () => {
    const res = await request(app).get("/api/me/jars").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    const entry = res.body.jars.find((j: { jarId: string }) => j.jarId === jarId);
    expect(entry.targetDatePrecision).toBe("year");
  });
});
