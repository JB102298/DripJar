/**
 * Pre-beta hardening regression tests.
 *
 * Covers the private Test Mode beta blockers:
 *   DJ-001 — /api/download/codebase must not disclose source without auth,
 *            and must not exist at all in production.
 *   DJ-005 — POST and PATCH /jars/:jarId/schedule must reject malformed input.
 *   DJ-012 — production startup must fail closed when email configuration is
 *            missing, rather than booting healthy and silently sending nothing.
 */

import { describe, it, expect, beforeAll, afterEach } from "vitest";
import request from "supertest";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import app from "../app.js";
import { DIST_INDEX_PATH, ensureApiBuild } from "./support/ensure-api-build.js";

const BASE = "/api";

// ─── DJ-001: codebase download endpoint ───────────────────────────────────────

describe("DJ-001 — /api/download/codebase access control", () => {
  const ORIGINAL_NODE_ENV = process.env["NODE_ENV"];

  afterEach(() => {
    // devOnly reads NODE_ENV per request, so tests can toggle it — but must
    // always restore it or later suites run under the wrong environment.
    process.env["NODE_ENV"] = ORIGINAL_NODE_ENV;
  });

  it("rejects an anonymous caller (no source disclosure without auth)", async () => {
    const res = await request(app).get(`${BASE}/download/codebase`);
    expect(res.status).toBe(401);
  });

  it("rejects a malformed bearer token", async () => {
    const res = await request(app)
      .get(`${BASE}/download/codebase`)
      .set("Authorization", "Bearer not-a-real-token");
    expect(res.status).toBe(401);
  });

  it("returns 404 in production even for an anonymous caller", async () => {
    process.env["NODE_ENV"] = "production";
    const res = await request(app).get(`${BASE}/download/codebase`);
    // 404, not 401 — production must not reveal that the route exists.
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("NotFound");
  });

  it("returns 404 in production even with a valid token", async () => {
    const reg = await request(app).post(`${BASE}/auth/register`).send({
      email: `dl-prod-${Date.now()}@test.invalid`,
      password: "P@ssword1!",
      firstName: "Down",
      lastName: "Load",
    });
    expect(reg.status).toBe(201);

    process.env["NODE_ENV"] = "production";
    const res = await request(app)
      .get(`${BASE}/download/codebase`)
      .set("Authorization", `Bearer ${reg.body.token}`);

    expect(res.status).toBe(404);
  });

  it("does not leak a filesystem path in the not-generated response", async () => {
    const reg = await request(app).post(`${BASE}/auth/register`).send({
      email: `dl-dev-${Date.now()}@test.invalid`,
      password: "P@ssword1!",
      firstName: "Down",
      lastName: "Load",
    });
    const res = await request(app)
      .get(`${BASE}/download/codebase`)
      .set("Authorization", `Bearer ${reg.body.token}`);

    // Authenticated in a non-production env: either the PDF is served (200) or
    // it has not been generated (404). The one thing it must never be is 401.
    expect([200, 404]).toContain(res.status);
    if (res.status === 404) {
      expect(JSON.stringify(res.body)).not.toMatch(/[A-Za-z]:\\|\/home\/|\/Users\//);
    }
  });
});

// ─── DJ-005: schedule input validation ────────────────────────────────────────

async function register(suffix: string) {
  const email = `prebeta-${suffix}-${Date.now()}-${Math.floor(performance.now())}@test.invalid`;
  const res = await request(app).post(`${BASE}/auth/register`).send({
    email, password: "P@ssword1!", firstName: "Pre", lastName: "Beta",
  });
  expect(res.status).toBe(201);
  return { token: res.body.token as string, email };
}

describe("DJ-005 — schedule validation", () => {
  let token: string;
  let jarId: string;
  let futureDate: string;

  beforeAll(async () => {
    const org = await register("sched");
    token = org.token;

    const target = new Date();
    target.setFullYear(target.getFullYear() + 1);
    const jarRes = await request(app)
      .post(`${BASE}/jars`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        name: "Schedule Validation Jar",
        category: "Vacation",
        targetDate: target.toISOString().slice(0, 10),
        goalAmountCents: 100000,
      });
    expect(jarRes.status).toBe(201);
    jarId = jarRes.body.id;

    await request(app)
      .post(`${BASE}/jars/${jarId}/launch`)
      .set("Authorization", `Bearer ${token}`);

    // Schedules require a currently-accepted agreement.
    const agreements = await request(app)
      .get(`${BASE}/jars/${jarId}/agreements`)
      .set("Authorization", `Bearer ${token}`);
    const agreementId = agreements.body?.[0]?.id;
    if (agreementId) {
      await request(app)
        .post(`${BASE}/jars/${jarId}/agreements/${agreementId}/accept`)
        .set("Authorization", `Bearer ${token}`);
    }

    const start = new Date();
    start.setMonth(start.getMonth() + 1);
    futureDate = start.toISOString().slice(0, 10);
  });

  function post(body: Record<string, unknown>) {
    return request(app)
      .post(`${BASE}/jars/${jarId}/schedule`)
      .set("Authorization", `Bearer ${token}`)
      .send(body);
  }

  // Each case is a single field mutated away from an otherwise-valid body.
  const invalidCases: Array<{ label: string; patch: Record<string, unknown>; field: string }> = [
    { label: "negative amountCents", patch: { amountCents: -50000 }, field: "amountCents" },
    { label: "zero amountCents", patch: { amountCents: 0 }, field: "amountCents" },
    { label: "non-integer amountCents", patch: { amountCents: 1000.5 }, field: "amountCents" },
    { label: "amountCents above the maximum", patch: { amountCents: 100_000_001 }, field: "amountCents" },
    { label: "amountCents as a string", patch: { amountCents: "5000" }, field: "amountCents" },
    { label: "unsupported frequency", patch: { frequency: "annually" }, field: "frequency" },
    { label: "empty frequency", patch: { frequency: "" }, field: "frequency" },
    { label: "preferredDay below range", patch: { preferredDay: 0 }, field: "preferredDay" },
    { label: "preferredDay above range", patch: { preferredDay: 29 }, field: "preferredDay" },
    { label: "negative preferredDay", patch: { preferredDay: -5 }, field: "preferredDay" },
    { label: "non-integer preferredDay", patch: { preferredDay: 12.5 }, field: "preferredDay" },
    { label: "malformed startDate", patch: { startDate: "not-a-date" }, field: "startDate" },
    { label: "impossible calendar date", patch: { startDate: "2026-02-31" }, field: "startDate" },
    { label: "startDate in the wrong format", patch: { startDate: "01/15/2026" }, field: "startDate" },
  ];

  for (const { label, patch, field } of invalidCases) {
    it(`rejects ${label}`, async () => {
      const res = await post({
        frequency: "monthly",
        amountCents: 10000,
        startDate: futureDate,
        ...patch,
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("ValidationError");
      expect(Object.keys(res.body.fields ?? {})).toContain(field);
    });
  }

  it("rejects a missing required field", async () => {
    const res = await post({ amountCents: 10000, startDate: futureDate });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("ValidationError");
  });

  it("rejects unknown fields", async () => {
    const res = await post({
      frequency: "monthly",
      amountCents: 10000,
      startDate: futureDate,
      isAdmin: true,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("ValidationError");
  });

  it("accepts a valid schedule", async () => {
    const res = await post({
      frequency: "monthly",
      amountCents: 10000,
      startDate: futureDate,
      preferredDay: 15,
    });
    expect(res.status).toBe(201);
    expect(res.body.frequency).toBe("monthly");
    expect(res.body.amountCents).toBe(10000);
    expect(res.body.preferredDay).toBe(15);
  });

  it("accepts every supported frequency", async () => {
    for (const frequency of ["weekly", "biweekly", "monthly", "twiceMonthly"]) {
      const res = await post({ frequency, amountCents: 5000, startDate: futureDate });
      expect(res.status, `frequency ${frequency} should be accepted`).toBe(201);
    }
  });

  it("accepts preferredDay at both range boundaries", async () => {
    for (const preferredDay of [1, 28]) {
      const res = await post({
        frequency: "monthly", amountCents: 5000, startDate: futureDate, preferredDay,
      });
      expect(res.status, `preferredDay ${preferredDay} should be accepted`).toBe(201);
    }
  });

  // PATCH shares the rules — otherwise a caller could create a valid schedule
  // and then mutate it into an invalid one, bypassing creation-time validation.
  describe("PATCH applies the same rules", () => {
    beforeAll(async () => {
      await post({ frequency: "monthly", amountCents: 10000, startDate: futureDate });
    });

    function patchSchedule(body: Record<string, unknown>) {
      return request(app)
        .patch(`${BASE}/jars/${jarId}/schedule`)
        .set("Authorization", `Bearer ${token}`)
        .send(body);
    }

    it("rejects a negative amountCents", async () => {
      const res = await patchSchedule({ amountCents: -1 });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("ValidationError");
    });

    it("rejects an out-of-range preferredDay", async () => {
      const res = await patchSchedule({ preferredDay: 31 });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("ValidationError");
    });

    it("rejects an unsupported frequency", async () => {
      const res = await patchSchedule({ frequency: "hourly" });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("ValidationError");
    });

    it("accepts a valid update", async () => {
      const res = await patchSchedule({ amountCents: 25000 });
      expect(res.status).toBe(200);
      expect(res.body.amountCents).toBe(25000);
    });
  });

  it("still returns 403/404 for a non-member, even with an invalid body", async () => {
    const outsider = await register("outsider");
    const res = await request(app)
      .post(`${BASE}/jars/${jarId}/schedule`)
      .set("Authorization", `Bearer ${outsider.token}`)
      .send({ frequency: "nonsense", amountCents: -1, startDate: "bad" });

    // Authorization must be decided before body validation, so an outsider
    // never learns whether their payload would have been accepted.
    expect([403, 404]).toContain(res.status);
  });
});

// ─── DJ-012: production email configuration guard ─────────────────────────────

const distIndexPath = DIST_INDEX_PATH;

describe("DJ-012 — production email configuration guard", () => {
  const VALID_JWT_SECRET = "x".repeat(48);

  // The startup guard lives in index.ts, which only runs as a real process — it
  // cannot be exercised by importing app.ts. That means spawning the built
  // bundle, so these tests depend on dist/ existing. Build on demand so they
  // are self-contained rather than order-dependent.
  beforeAll(() => { ensureApiBuild(); }, 130_000);

  /** Run the built server with a controlled environment and capture its output. */
  function runServer(env: Record<string, string | undefined>) {
    const childEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries({ ...process.env, ...env })) {
      if (v !== undefined) childEnv[k] = v;
    }
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete childEnv[k];
    }

    return spawnSync("node", [distIndexPath], {
      env: childEnv,
      encoding: "utf8",
      timeout: 10_000,
    });
  }

  it("the built server exists (run `pnpm --filter @workspace/api-server run build`)", () => {
    expect(existsSync(distIndexPath)).toBe(true);
  });

  it("exits 1 in production when RESEND_API_KEY is absent", () => {
    const result = runServer({
      NODE_ENV: "production",
      JWT_SECRET: VALID_JWT_SECRET,
      RESEND_API_KEY: undefined,
      APP_BASE_URL: "https://example.invalid",
    });
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toMatch(/RESEND_API_KEY/);
  });

  it("exits 1 in production when APP_BASE_URL is absent", () => {
    const result = runServer({
      NODE_ENV: "production",
      JWT_SECRET: VALID_JWT_SECRET,
      RESEND_API_KEY: "re_test_placeholder",
      APP_BASE_URL: undefined,
    });
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toMatch(/APP_BASE_URL/);
  });

  it("names every missing variable at once", () => {
    const result = runServer({
      NODE_ENV: "production",
      JWT_SECRET: VALID_JWT_SECRET,
      RESEND_API_KEY: undefined,
      APP_BASE_URL: undefined,
    });
    expect(result.status).toBe(1);
    const output = result.stdout + result.stderr;
    expect(output).toMatch(/RESEND_API_KEY/);
    expect(output).toMatch(/APP_BASE_URL/);
  });

  it("never echoes the key's value", () => {
    const secretValue = "re_super_secret_value_do_not_log";
    const result = runServer({
      NODE_ENV: "production",
      JWT_SECRET: VALID_JWT_SECRET,
      RESEND_API_KEY: secretValue,
      APP_BASE_URL: undefined,
    });
    expect(result.stdout + result.stderr).not.toContain(secretValue);
  });

  describe("emailed-link base URL precedence", () => {
    const saved = {
      NODE_ENV: process.env["NODE_ENV"],
      APP_BASE_URL: process.env["APP_BASE_URL"],
      REPLIT_DEV_DOMAIN: process.env["REPLIT_DEV_DOMAIN"],
    };

    afterEach(() => {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });

    it("prefers APP_BASE_URL over REPLIT_DEV_DOMAIN in production", async () => {
      // A Replit production deploy can still expose REPLIT_DEV_DOMAIN. Emailed
      // links must resolve to the configured production origin, not the preview.
      process.env["NODE_ENV"] = "production";
      process.env["REPLIT_DEV_DOMAIN"] = "preview.replit.dev";
      process.env["APP_BASE_URL"] = "https://prod.example";

      const { getAppBaseUrl } = await import("../lib/email.js");
      expect(getAppBaseUrl()).toBe("https://prod.example");
    });

    it("still prefers REPLIT_DEV_DOMAIN outside production (unchanged)", async () => {
      process.env["NODE_ENV"] = "development";
      process.env["REPLIT_DEV_DOMAIN"] = "preview.replit.dev";
      process.env["APP_BASE_URL"] = "https://should-not-win.example";

      const { getAppBaseUrl } = await import("../lib/email.js");
      expect(getAppBaseUrl()).toBe("https://preview.replit.dev");
    });
  });

  it("does not apply the guard outside production", () => {
    // No RESEND_API_KEY and no PORT. If the email guard were active it would
    // report RESEND_API_KEY; instead startup must proceed past it and fail on
    // PORT. This proves dev/test stay permissive without starting a server.
    const result = runServer({
      NODE_ENV: "development",
      JWT_SECRET: VALID_JWT_SECRET,
      RESEND_API_KEY: undefined,
      APP_BASE_URL: undefined,
      PORT: undefined,
    });
    expect(result.status).toBe(1);
    const output = result.stdout + result.stderr;
    expect(output).toMatch(/PORT/);
    expect(output).not.toMatch(/RESEND_API_KEY/);
  });
});
