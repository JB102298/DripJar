/**
 * Rate-limit integration tests
 *
 * Run via:  pnpm --filter @workspace/api-server run test:rate-limits
 * That command sets TEST_RATE_LIMITS=1, which switches createLimiter() from
 * no-op (used by the normal test suite) to real express-rate-limit middleware.
 *
 * Isolation strategy
 * ──────────────────
 * app.ts sets `trust proxy: 1`, so Express honours the X-Forwarded-For header.
 * Each describe block is assigned a unique RFC 5737 TEST-NET-1 address
 * (192.0.2.x) as its synthetic IP.  In-memory counters are keyed by IP, so
 * blocks never share state with each other.
 *
 * Because this file is excluded from vitest.config.ts, the normal test command
 * never runs it and its exhausted counters never leak into the auth test suite.
 */

import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import app from "../app.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a supertest request with the given synthetic client IP pre-set on
 * X-Forwarded-For.  Must call .post() / .get() BEFORE .set() in supertest 7,
 * so this helper returns a small dispatcher instead.
 */
function api(ip: string) {
  return {
    post: (path: string) => request(app).post(path).set("X-Forwarded-For", ip),
    get:  (path: string) => request(app).get(path).set("X-Forwarded-For", ip),
  };
}

const FAKE_JAR_A = "00000000-0000-4000-8000-000000000001";
const FAKE_JAR_B = "00000000-0000-4000-8000-000000000002";
const FAKE_JAR_C = "00000000-0000-4000-8000-000000000003";

// ─── Login limiter  (10 per 15 min per IP) ────────────────────────────────────

describe("Login rate limiter", () => {
  const IP = "192.0.2.10";

  it("allows requests up to the configured threshold (returns auth failure, not 429)", async () => {
    for (let i = 0; i < 10; i++) {
      const res = await api(IP)
        .post("/api/auth/login")
        .send({ email: `nonexistent${i}@example.com`, password: "wrongpassword" });
      expect(res.status).not.toBe(429);
    }
  });

  it("returns 429 on the request after the threshold is reached", async () => {
    const res = await api(IP)
      .post("/api/auth/login")
      .send({ email: "nonexistent@example.com", password: "wrongpassword" });
    expect(res.status).toBe(429);
  });

  it("429 response uses the application's consistent error shape", async () => {
    const res = await api(IP)
      .post("/api/auth/login")
      .send({ email: "x@example.com", password: "wrongpassword" });
    expect(res.status).toBe(429);
    expect(res.body.error).toBe("TooManyRequests");
    expect(typeof res.body.message).toBe("string");
    expect(res.body.message.length).toBeGreaterThan(0);
  });

  it("429 response includes standard rate-limit headers", async () => {
    const res = await api(IP)
      .post("/api/auth/login")
      .send({ email: "x@example.com", password: "wrongpassword" });
    expect(res.status).toBe(429);
    // express-rate-limit draft-7 sends Retry-After and/or RateLimit-* headers
    const headers = Object.keys(res.headers).map((h) => h.toLowerCase());
    const hasRetryAfter = headers.includes("retry-after");
    const hasRateLimitHeader = headers.some((h) => h.startsWith("ratelimit-"));
    expect(hasRetryAfter || hasRateLimitHeader).toBe(true);
  });

  it("429 response does not reveal email existence, password details, tokens, or stack traces", async () => {
    const res = await api(IP)
      .post("/api/auth/login")
      .send({ email: "target@example.com", password: "wrongpassword" });
    expect(res.status).toBe(429);
    // The body must not echo back the submitted email address
    expect(JSON.stringify(res.body)).not.toMatch(/target@example\.com/);
    // No password hints
    expect(JSON.stringify(res.body)).not.toMatch(/"password"/i);
    // No token fields
    expect(res.body.token).toBeUndefined();
    expect(res.body.refreshToken).toBeUndefined();
    // No stack trace
    expect(res.body.stack).toBeUndefined();
  });
});

// ─── Register limiter  (5 per hour per IP) ────────────────────────────────────

describe("Register rate limiter", () => {
  const IP = "192.0.2.20";

  it("enforces the configured hourly threshold", async () => {
    const email = "rl-reg@test.example";

    // 5 attempts must not be blocked by rate limiting.
    // First call creates the account (201); subsequent calls get 409 (duplicate).
    // In all cases the rate limiter must not be the reason for rejection.
    for (let i = 0; i < 5; i++) {
      const res = await api(IP)
        .post("/api/auth/register")
        .send({ email, password: "Password123!", firstName: "RL", lastName: "Test" });
      expect(res.status).not.toBe(429);
    }

    // 6th attempt from the same IP — limiter must now fire
    const res = await api(IP)
      .post("/api/auth/register")
      .send({ email, password: "Password123!", firstName: "RL", lastName: "Test" });
    expect(res.status).toBe(429);
    expect(res.body.error).toBe("TooManyRequests");
  });
});

// ─── Forgot-password limiter  (5 per hour per IP) ─────────────────────────────

describe("Forgot-password rate limiter", () => {
  // Primary IP used to exhaust the counter
  const IP = "192.0.2.30";
  // Secondary IP used for the email-normalisation variant
  const IP2 = "192.0.2.31";

  it("enforces the configured IP threshold", async () => {
    for (let i = 0; i < 5; i++) {
      const res = await api(IP)
        .post("/api/auth/forgot-password")
        .send({ email: `user${i}@example.com` });
      expect(res.status).not.toBe(429);
    }

    const res = await api(IP)
      .post("/api/auth/forgot-password")
      .send({ email: "user@example.com" });
    expect(res.status).toBe(429);
    expect(res.body.error).toBe("TooManyRequests");
  });

  it("email case normalisation: uppercase and lowercase emails count toward the same IP counter", async () => {
    // The limiter is IP-keyed; any email variant from the same IP increments
    // the same counter.  Exhaust the limit, then confirm both cases hit 429.
    for (let i = 0; i < 5; i++) {
      await api(IP2).post("/api/auth/forgot-password").send({ email: `u${i}@example.com` });
    }
    const [lower, upper] = await Promise.all([
      api(IP2).post("/api/auth/forgot-password").send({ email: "user@example.com" }),
      api(IP2).post("/api/auth/forgot-password").send({ email: "USER@EXAMPLE.COM" }),
    ]);
    expect(lower.status).toBe(429);
    expect(upper.status).toBe(429);
  });
});

// ─── Refresh-token limiter  (30 per 15 min per IP) ────────────────────────────

describe("Refresh-token rate limiter", () => {
  const IP = "192.0.2.40";

  it("enforces the configured threshold", async () => {
    // The limiter fires before validation and handler logic, so a syntactically
    // valid but semantically unknown refresh token still increments the counter.
    const fakeToken = "fake-refresh-token-for-rate-limit-test";

    for (let i = 0; i < 30; i++) {
      const res = await api(IP)
        .post("/api/auth/refresh")
        .send({ refreshToken: fakeToken });
      // Limiter allows these through; handler rejects with 401
      expect(res.status).not.toBe(429);
    }

    const res = await api(IP)
      .post("/api/auth/refresh")
      .send({ refreshToken: fakeToken });
    expect(res.status).toBe(429);
    expect(res.body.error).toBe("TooManyRequests");
  });
});

// ─── Invitation limiter  (30 per 15 min per IP) ───────────────────────────────

describe("Invitation rate limiter", () => {
  const IP = "192.0.2.50";
  let accessToken: string;

  beforeAll(async () => {
    // Register with no X-Forwarded-For override so this call goes against
    // 127.0.0.1, which is a separate counter from all test IPs.
    const res = await request(app)
      .post("/api/auth/register")
      .send({
        email: `rl-invite-${Date.now()}@test.example`,
        password: "Password123!",
        firstName: "RL",
        lastName: "Invite",
      });
    expect(res.status).toBe(201);
    accessToken = res.body.token as string;
  });

  it("enforces the threshold on the POST invitation endpoint", async () => {
    // requireAuth passes (valid JWT); invitationLimiter fires next.
    // Requests return 404 (jar not found) until the counter is exhausted.
    for (let i = 0; i < 30; i++) {
      const res = await api(IP)
        .post(`/api/jars/${FAKE_JAR_A}/invitations`)
        .set("Authorization", `Bearer ${accessToken}`)
        .send({ email: `invitee${i}@example.com` });
      expect(res.status).not.toBe(429);
    }

    const res = await api(IP)
      .post(`/api/jars/${FAKE_JAR_A}/invitations`)
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ email: "invitee@example.com" });
    expect(res.status).toBe(429);
    expect(res.body.error).toBe("TooManyRequests");
  });
});

// ─── Contribution limiter  (60 per 15 min per IP) ─────────────────────────────

describe("Contribution rate limiter", () => {
  const POST_IP = "192.0.2.60";
  const GET_IP  = "192.0.2.70";
  let accessToken: string;

  beforeAll(async () => {
    const res = await request(app)
      .post("/api/auth/register")
      .send({
        email: `rl-contrib-${Date.now()}@test.example`,
        password: "Password123!",
        firstName: "RL",
        lastName: "Contrib",
      });
    expect(res.status).toBe(201);
    accessToken = res.body.token as string;
  });

  it("enforces the threshold on the POST contribution endpoint", async () => {
    for (let i = 0; i < 60; i++) {
      const res = await api(POST_IP)
        .post(`/api/jars/${FAKE_JAR_B}/contributions`)
        .set("Authorization", `Bearer ${accessToken}`)
        .send({ amountCents: 1000, note: "rl-test" });
      expect(res.status).not.toBe(429);
    }

    const res = await api(POST_IP)
      .post(`/api/jars/${FAKE_JAR_B}/contributions`)
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ amountCents: 1000, note: "rl-test" });
    expect(res.status).toBe(429);
    expect(res.body.error).toBe("TooManyRequests");
  });

  it("does not rate-limit the read-only GET endpoint", async () => {
    // Send more requests than the POST limit to confirm there is no limiter
    // accidentally applied to the read path.
    for (let i = 0; i < 65; i++) {
      const res = await api(GET_IP)
        .get(`/api/jars/${FAKE_JAR_C}/contributions`)
        .set("Authorization", `Bearer ${accessToken}`);
      expect(res.status).not.toBe(429);
    }
  });
});

// ─── IP isolation ─────────────────────────────────────────────────────────────

describe("Rate-limit IP isolation", () => {
  it("exhausting one IP's counter does not affect a different IP", async () => {
    const IP_A = "192.0.2.80";
    const IP_B = "192.0.2.81";

    // Exhaust IP_A's login counter
    for (let i = 0; i < 10; i++) {
      await api(IP_A).post("/api/auth/login").send({ email: "x@example.com", password: "wrong" });
    }
    const blockedA = await api(IP_A)
      .post("/api/auth/login")
      .send({ email: "x@example.com", password: "wrong" });
    expect(blockedA.status).toBe(429);

    // IP_B has an independent counter — must still be allowed
    const allowedB = await api(IP_B)
      .post("/api/auth/login")
      .send({ email: "x@example.com", password: "wrong" });
    expect(allowedB.status).not.toBe(429);
  });
});
