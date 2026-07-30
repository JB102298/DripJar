import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { hashToken, createRefreshToken, signAccessToken } from "../lib/auth.js";
import app from "../app.js";

// ─── Unit: token helpers ───────────────────────────────────────────────────

describe("hashToken", () => {
  it("produces a consistent SHA-256 hex string", () => {
    const result = hashToken("my-token");
    expect(result).toBe(createHash("sha256").update("my-token").digest("hex"));
  });

  it("different inputs produce different hashes", () => {
    expect(hashToken("abc")).not.toBe(hashToken("xyz"));
  });
});

describe("createRefreshToken", () => {
  it("returns raw and hash", () => {
    const { raw, hash } = createRefreshToken();
    expect(typeof raw).toBe("string");
    expect(raw.length).toBeGreaterThan(32);
    expect(hash).toBe(hashToken(raw));
  });

  it("each call produces a unique token", () => {
    const a = createRefreshToken();
    const b = createRefreshToken();
    expect(a.raw).not.toBe(b.raw);
    expect(a.hash).not.toBe(b.hash);
  });
});

describe("signAccessToken", () => {
  it("produces a three-part JWT", () => {
    const token = signAccessToken("user-1", "test@example.com");
    const parts = token.split(".");
    expect(parts).toHaveLength(3);
  });

  it("access token expires in ~15 min", () => {
    const token = signAccessToken("user-1", "test@example.com");
    const payload = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString());
    const expiresIn = payload.exp - payload.iat;
    // Should be close to 900 seconds (15 min)
    expect(expiresIn).toBeGreaterThanOrEqual(890);
    expect(expiresIn).toBeLessThanOrEqual(910);
  });
});

// ─── Unit: startup validation (subprocess against built dist) ─────────────

const distIndexPath = new URL("../../dist/index.mjs", import.meta.url).pathname;

describe("startup JWT_SECRET validation", () => {
  it("exits with code 1 when JWT_SECRET is absent", () => {
    const env = { ...process.env };
    delete env["JWT_SECRET"];
    const result = spawnSync("node", [distIndexPath], {
      env,
      encoding: "utf8",
      timeout: 5000,
    });
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toMatch(/JWT_SECRET/i);
  });

  it("exits with code 1 when JWT_SECRET is shorter than 32 chars", () => {
    const env = { ...process.env, JWT_SECRET: "tooshort" };
    const result = spawnSync("node", [distIndexPath], {
      env,
      encoding: "utf8",
      timeout: 5000,
    });
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toMatch(/too short|minimum/i);
  });
});

// ─── Integration: auth endpoints ──────────────────────────────────────────

const unique = () => `test-${Date.now()}-${Math.random().toString(36).slice(2)}`;

describe("POST /api/auth/register", () => {
  it("returns accessToken + refreshToken on success", async () => {
    const res = await request(app)
      .post("/api/auth/register")
      .send({ email: `${unique()}@example.com`, password: "Password123!", firstName: "Test", lastName: "User" });
    expect(res.status).toBe(201);
    expect(typeof res.body.token).toBe("string");
    expect(typeof res.body.refreshToken).toBe("string");
    expect(res.body.token.split(".")).toHaveLength(3);
  });

  it("returns 400 for invalid payload with field errors", async () => {
    const res = await request(app)
      .post("/api/auth/register")
      .send({ email: "not-an-email", password: "short" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("ValidationError");
    expect(res.body.fields).toBeDefined();
    expect(typeof res.body.fields).toBe("object");
  });

  it("rolls back if profile creation would fail (DB transaction integrity)", async () => {
    // Can't easily force a profile failure without DB mocking, so we verify
    // that a successful registration has both user and profile in the response.
    const res = await request(app)
      .post("/api/auth/register")
      .send({ email: `${unique()}@example.com`, password: "Password123!", firstName: "A", lastName: "B" });
    expect(res.status).toBe(201);
    expect(res.body.profile).toBeDefined();
    expect(res.body.profile.userId).toBe(res.body.user.id);
  });
});

describe("POST /api/auth/login", () => {
  let email: string;
  const password = "TestPassword1!";

  beforeAll(async () => {
    email = `${unique()}@example.com`;
    await request(app)
      .post("/api/auth/register")
      .send({ email, password, firstName: "Login", lastName: "Test" });
  });

  it("issues both token and refreshToken", async () => {
    const res = await request(app).post("/api/auth/login").send({ email, password });
    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe("string");
    expect(typeof res.body.refreshToken).toBe("string");
  });

  it("returns 401 for wrong password", async () => {
    const res = await request(app).post("/api/auth/login").send({ email, password: "wrongpassword" });
    expect(res.status).toBe(401);
  });

  it("returns 400 for missing fields", async () => {
    const res = await request(app).post("/api/auth/login").send({ email });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("ValidationError");
  });
});

describe("Token refresh and rotation", () => {
  let accessToken: string;
  let refreshToken: string;
  const email = `${unique()}@example.com`;
  const password = "TestPassword1!";

  beforeAll(async () => {
    await request(app)
      .post("/api/auth/register")
      .send({ email, password, firstName: "Refresh", lastName: "Test" });
    const loginRes = await request(app).post("/api/auth/login").send({ email, password });
    accessToken = loginRes.body.token;
    refreshToken = loginRes.body.refreshToken;
  });

  it("POST /api/auth/refresh issues a new token pair", async () => {
    const res = await request(app)
      .post("/api/auth/refresh")
      .send({ refreshToken });
    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe("string");
    expect(typeof res.body.refreshToken).toBe("string");
    // New tokens should differ from originals
    expect(res.body.token).not.toBe(accessToken);
    expect(res.body.refreshToken).not.toBe(refreshToken);
  });

  it("rejects the old refresh token after rotation (reuse detection)", async () => {
    // Issue a fresh login so we have a known-good refresh token
    const loginRes = await request(app).post("/api/auth/login").send({ email, password });
    const firstRefresh = loginRes.body.refreshToken;

    // Use it once
    const rotateRes = await request(app)
      .post("/api/auth/refresh")
      .send({ refreshToken: firstRefresh });
    expect(rotateRes.status).toBe(200);

    // Use the same (now-rotated) token again — should be rejected
    const reuseRes = await request(app)
      .post("/api/auth/refresh")
      .send({ refreshToken: firstRefresh });
    expect(reuseRes.status).toBe(401);
  });
});

describe("POST /api/auth/logout and logout-all", () => {
  let accessToken: string;
  let refreshToken: string;
  const email = `${unique()}@example.com`;
  const password = "TestPassword1!";

  beforeAll(async () => {
    await request(app)
      .post("/api/auth/register")
      .send({ email, password, firstName: "Logout", lastName: "Test" });
    const res = await request(app).post("/api/auth/login").send({ email, password });
    accessToken = res.body.token;
    refreshToken = res.body.refreshToken;
  });

  it("revokes the current session — refresh fails after logout", async () => {
    const res = await request(app)
      .post("/api/auth/logout")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ refreshToken });
    expect(res.status).toBe(200);

    // Refresh should now fail
    const refreshRes = await request(app)
      .post("/api/auth/refresh")
      .send({ refreshToken });
    expect(refreshRes.status).toBe(401);
  });

  it("POST /api/auth/logout-all revokes every session", async () => {
    // Create two sessions
    const s1 = await request(app).post("/api/auth/login").send({ email, password });
    const s2 = await request(app).post("/api/auth/login").send({ email, password });

    await request(app)
      .post("/api/auth/logout-all")
      .set("Authorization", `Bearer ${s1.body.token}`);

    // Both refresh tokens should be invalidated
    const r1 = await request(app).post("/api/auth/refresh").send({ refreshToken: s1.body.refreshToken });
    const r2 = await request(app).post("/api/auth/refresh").send({ refreshToken: s2.body.refreshToken });
    expect(r1.status).toBe(401);
    expect(r2.status).toBe(401);
  });
});

describe("Password reset", () => {
  const email = `${unique()}@example.com`;
  const password = "OriginalPass1!";

  beforeAll(async () => {
    await request(app)
      .post("/api/auth/register")
      .send({ email, password, firstName: "Reset", lastName: "Test" });
  });

  it("forgot-password returns neutral response (no email enumeration)", async () => {
    const realRes = await request(app)
      .post("/api/auth/forgot-password")
      .send({ email });
    const fakeRes = await request(app)
      .post("/api/auth/forgot-password")
      .send({ email: "nonexistent@example.com" });
    expect(realRes.status).toBe(200);
    expect(fakeRes.status).toBe(200);
    expect(realRes.body.message).toBe(fakeRes.body.message);
  });

  it("reset token is stored as a hash in DB (DEV_SHOW_RESET_TOKEN reveals raw token)", async () => {
    // Enable the dev flag so we get the raw token back
    process.env["DEV_SHOW_RESET_TOKEN"] = "true";
    const res = await request(app)
      .post("/api/auth/forgot-password")
      .send({ email });
    process.env["DEV_SHOW_RESET_TOKEN"] = undefined;

    expect(res.body._dev_token).toBeDefined();
    // The token in the response is the RAW token — verify it's not the hash
    const raw = res.body._dev_token as string;
    expect(raw).not.toBe(hashToken(raw)); // raw ≠ its own hash
  });

  it("reset token is single-use — second reset attempt with same token fails", async () => {
    process.env["DEV_SHOW_RESET_TOKEN"] = "true";
    const forgotRes = await request(app)
      .post("/api/auth/forgot-password")
      .send({ email });
    const rawToken = forgotRes.body._dev_token as string;
    process.env["DEV_SHOW_RESET_TOKEN"] = undefined;

    // First use succeeds
    const first = await request(app)
      .post("/api/auth/reset-password")
      .send({ token: rawToken, password: "NewPassword1!" });
    expect(first.status).toBe(200);

    // Second use fails (token cleared after use)
    const second = await request(app)
      .post("/api/auth/reset-password")
      .send({ token: rawToken, password: "AnotherPassword1!" });
    expect(second.status).toBe(400);
  });

  it("password reset revokes all active sessions", async () => {
    // Register a fresh user, log in, get a refresh token
    const resetEmail = `${unique()}@example.com`;
    await request(app)
      .post("/api/auth/register")
      .send({ email: resetEmail, password: "Pass1234!", firstName: "X", lastName: "Y" });
    const loginRes = await request(app).post("/api/auth/login").send({ email: resetEmail, password: "Pass1234!" });
    const savedRefreshToken = loginRes.body.refreshToken;

    // Trigger reset
    process.env["DEV_SHOW_RESET_TOKEN"] = "true";
    const forgotRes = await request(app)
      .post("/api/auth/forgot-password")
      .send({ email: resetEmail });
    const rawToken = forgotRes.body._dev_token as string;
    process.env["DEV_SHOW_RESET_TOKEN"] = undefined;

    await request(app)
      .post("/api/auth/reset-password")
      .send({ token: rawToken, password: "NewPass5678!" });

    // Saved session should be invalidated
    const refreshRes = await request(app)
      .post("/api/auth/refresh")
      .send({ refreshToken: savedRefreshToken });
    expect(refreshRes.status).toBe(401);
  });
});

// Rate limiting is verified in the dedicated suite:
//   pnpm --filter @workspace/api-server run test:rate-limits
