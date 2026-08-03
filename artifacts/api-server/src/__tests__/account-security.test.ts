/**
 * Phase 2 coverage: password change + email verification.
 *
 * - Change password: requires current password, revokes all refresh
 *   sessions, rejects wrong/same passwords, enforces policy.
 * - Email verification: hashed single-use token, expiry, dev-token gating
 *   identical to the reset flow.
 *
 * Runs against the real Express app + dev database.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import app from "../app.js";

const unique = () => `as-${Date.now()}-${Math.random().toString(36).slice(2)}`;

async function registerUser(password = "password123") {
  const email = `${unique()}@example.com`;
  const res = await request(app).post("/api/auth/register").send({
    email,
    password,
    firstName: "Test",
    lastName: "User",
  });
  expect(res.status).toBe(201);
  return {
    email,
    password,
    accessToken: res.body.token as string,
    refreshToken: res.body.refreshToken as string,
    userId: res.body.user.id as string,
  };
}

// ─── Change password ────────────────────────────────────────────────────────

describe("POST /auth/change-password", () => {
  it("requires authentication", async () => {
    const res = await request(app)
      .post("/api/auth/change-password")
      .send({ currentPassword: "x", newPassword: "newpassword1" });
    expect(res.status).toBe(401);
  });

  it("rejects an incorrect current password", async () => {
    const user = await registerUser();
    const res = await request(app)
      .post("/api/auth/change-password")
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ currentPassword: "wrong-password", newPassword: "newpassword1" });
    expect(res.status).toBe(401);
  });

  it("rejects a new password identical to the current one", async () => {
    const user = await registerUser();
    const res = await request(app)
      .post("/api/auth/change-password")
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ currentPassword: user.password, newPassword: user.password });
    expect(res.status).toBe(400);
  });

  it("enforces the password policy (min 8 chars)", async () => {
    const user = await registerUser();
    const res = await request(app)
      .post("/api/auth/change-password")
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ currentPassword: user.password, newPassword: "short" });
    expect(res.status).toBe(400);
  });

  it("changes the password and revokes ALL refresh sessions", async () => {
    const user = await registerUser();

    const res = await request(app)
      .post("/api/auth/change-password")
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ currentPassword: user.password, newPassword: "brand-new-password1" });
    expect(res.status).toBe(200);

    // Old refresh token no longer works (revoked with reason password_change)
    const refresh = await request(app)
      .post("/api/auth/refresh")
      .send({ refreshToken: user.refreshToken });
    expect(refresh.status).toBe(401);

    // Old password no longer valid; new one is
    const oldLogin = await request(app)
      .post("/api/auth/login")
      .send({ email: user.email, password: user.password });
    expect(oldLogin.status).toBe(401);

    const newLogin = await request(app)
      .post("/api/auth/login")
      .send({ email: user.email, password: "brand-new-password1" });
    expect(newLogin.status).toBe(200);
  });
});

// ─── Email verification ─────────────────────────────────────────────────────

// RESEND_API_KEY is cleared during the production-gating test so no real
// email delivery can ever be attempted from the suite.
const ENV_KEYS = ["NODE_ENV", "DEV_SHOW_VERIFICATION_TOKEN", "RESEND_API_KEY"] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe("email verification flow", () => {
  it("registration leaves the account unverified but usable", async () => {
    const user = await registerUser();
    const me = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${user.accessToken}`);
    expect(me.status).toBe(200);
    expect(me.body.user.emailVerified).toBe(false);
  });

  it("send-verification exposes a dev token only when gated on, and verify-email consumes it once", async () => {
    const user = await registerUser();

    // Without the dev flag, no token in the response
    delete process.env["DEV_SHOW_VERIFICATION_TOKEN"];
    const noToken = await request(app)
      .post("/api/auth/send-verification")
      .set("Authorization", `Bearer ${user.accessToken}`);
    expect(noToken.status).toBe(200);
    expect(noToken.body._dev_token).toBeUndefined();

    // With the dev flag (non-production), the raw token is exposed
    process.env["DEV_SHOW_VERIFICATION_TOKEN"] = "true";
    const withToken = await request(app)
      .post("/api/auth/send-verification")
      .set("Authorization", `Bearer ${user.accessToken}`);
    expect(withToken.status).toBe(200);
    const rawToken = withToken.body._dev_token as string;
    expect(typeof rawToken).toBe("string");
    expect(rawToken.length).toBeGreaterThan(32);

    // Public verify route consumes the token
    const verify = await request(app).post("/api/auth/verify-email").send({ token: rawToken });
    expect(verify.status).toBe(200);

    const me = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${user.accessToken}`);
    expect(me.body.user.emailVerified).toBe(true);

    // Single-use: the same token fails on replay
    const replay = await request(app).post("/api/auth/verify-email").send({ token: rawToken });
    expect(replay.status).toBe(400);

    // Already-verified users get the friendly no-op message (and no token)
    const again = await request(app)
      .post("/api/auth/send-verification")
      .set("Authorization", `Bearer ${user.accessToken}`);
    expect(again.status).toBe(200);
    expect(again.body._dev_token).toBeUndefined();
    expect(again.body.message).toMatch(/already verified/i);
  });

  it("is single-use even under concurrent verification attempts", async () => {
    const user = await registerUser();
    process.env["DEV_SHOW_VERIFICATION_TOKEN"] = "true";
    const sent = await request(app)
      .post("/api/auth/send-verification")
      .set("Authorization", `Bearer ${user.accessToken}`);
    const rawToken = sent.body._dev_token as string;

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        request(app).post("/api/auth/verify-email").send({ token: rawToken }),
      ),
    );
    const successes = results.filter((r) => r.status === 200).length;
    expect(successes).toBe(1);
  });

  it("rejects an invalid verification token", async () => {
    const res = await request(app)
      .post("/api/auth/verify-email")
      .send({ token: "definitely-not-a-real-token" });
    expect(res.status).toBe(400);
  });

  it("never exposes a dev token when NODE_ENV=production", async () => {
    const user = await registerUser();
    process.env["DEV_SHOW_VERIFICATION_TOKEN"] = "true";
    delete process.env["RESEND_API_KEY"]; // ensure no real delivery attempt
    process.env["NODE_ENV"] = "production";
    try {
      const res = await request(app)
        .post("/api/auth/send-verification")
        .set("Authorization", `Bearer ${user.accessToken}`);
      expect(res.status).toBe(200);
      expect(res.body._dev_token).toBeUndefined();
    } finally {
      process.env["NODE_ENV"] = savedEnv["NODE_ENV"];
    }
  });
});
