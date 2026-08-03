/**
 * Phase 3A coverage: password-reset email behavior, m3jar.com fallbacks,
 * production reset-token guard, and delivery-failure anti-enumeration.
 *
 * The email module itself is exercised as pure helpers (URL/sender/base-url
 * construction). Route-level behavior is exercised through the real Express
 * app with the email module mocked where delivery failure must be simulated.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";

// Mock the email module for ROUTE tests so we can simulate delivery failure
// and assert call behavior. Helper functions are re-exported from the actual
// implementation so fallback tests still test real code.
const sendPasswordResetEmailMock = vi.fn(
  async (_opts: { toEmail: string; token: string }): Promise<void> => undefined,
);
vi.mock("../lib/email.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    sendPasswordResetEmail: (opts: { toEmail: string; token: string }) =>
      sendPasswordResetEmailMock(opts),
  };
});

import app from "../app.js";
import { getAppBaseUrl, getFromAddress, buildPasswordResetUrl } from "../lib/email.js";

const unique = () => `pre-${Date.now()}-${Math.random().toString(36).slice(2)}`;

// ─── Env manipulation helpers ────────────────────────────────────────────────

const ENV_KEYS = ["REPLIT_DEV_DOMAIN", "APP_BASE_URL", "EMAIL_FROM", "NODE_ENV", "DEV_SHOW_RESET_TOKEN"] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  sendPasswordResetEmailMock.mockClear();
  sendPasswordResetEmailMock.mockImplementation(async () => undefined);
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

// ─── Unit: URL and sender fallbacks ──────────────────────────────────────────

describe("email base-url and sender fallbacks", () => {
  it("uses REPLIT_DEV_DOMAIN when present (dev)", () => {
    process.env["REPLIT_DEV_DOMAIN"] = "my-dev.replit.dev";
    process.env["APP_BASE_URL"] = "https://should-not-win.example";
    expect(getAppBaseUrl()).toBe("https://my-dev.replit.dev");
  });

  it("uses APP_BASE_URL when no dev domain (production override)", () => {
    delete process.env["REPLIT_DEV_DOMAIN"];
    process.env["APP_BASE_URL"] = "https://m3jar.com";
    expect(getAppBaseUrl()).toBe("https://m3jar.com");
  });

  it("falls back to https://m3jar.com when no env overrides exist", () => {
    delete process.env["REPLIT_DEV_DOMAIN"];
    delete process.env["APP_BASE_URL"];
    expect(getAppBaseUrl()).toBe("https://m3jar.com");
  });

  it("EMAIL_FROM env var overrides the sender fallback", () => {
    process.env["EMAIL_FROM"] = "M3Jar <hello@m3jar.com>";
    expect(getFromAddress()).toBe("M3Jar <hello@m3jar.com>");
  });

  it("sender fallback is the m3jar.com transactional subdomain", () => {
    delete process.env["EMAIL_FROM"];
    expect(getFromAddress()).toBe("M3Jar <noreply@updates.m3jar.com>");
  });

  it("builds the reset URL as {base}/reset-password/{rawToken}", () => {
    delete process.env["REPLIT_DEV_DOMAIN"];
    delete process.env["APP_BASE_URL"];
    expect(buildPasswordResetUrl("tok123")).toBe("https://m3jar.com/reset-password/tok123");
  });
});

// ─── Route: forgot-password wiring + anti-enumeration ────────────────────────

describe("POST /auth/forgot-password email wiring", () => {
  const email = `${unique()}@example.com`;
  const password = "OriginalPass1!";

  it("sends a reset email for an existing account and none for unknown ones", async () => {
    await request(app)
      .post("/api/auth/register")
      .send({ email, password, firstName: "Mail", lastName: "Flow" });

    const real = await request(app).post("/api/auth/forgot-password").send({ email });
    expect(real.status).toBe(200);
    expect(sendPasswordResetEmailMock).toHaveBeenCalledTimes(1);
    const arg = sendPasswordResetEmailMock.mock.calls[0]![0];
    expect(arg.toEmail).toBe(email);
    expect(typeof arg.token).toBe("string");
    expect(arg.token.length).toBe(64); // 32 random bytes hex

    sendPasswordResetEmailMock.mockClear();
    const fake = await request(app)
      .post("/api/auth/forgot-password")
      .send({ email: `${unique()}@example.com` });
    expect(fake.status).toBe(200);
    expect(sendPasswordResetEmailMock).not.toHaveBeenCalled();
    // Identical response bodies — no enumeration signal
    expect(fake.body.message).toBe(real.body.message);
  });

  it("email delivery failure does not alter the generic response", async () => {
    sendPasswordResetEmailMock.mockImplementation(async () => {
      throw new Error("Resend exploded");
    });

    const failing = await request(app).post("/api/auth/forgot-password").send({ email });
    const unknown = await request(app)
      .post("/api/auth/forgot-password")
      .send({ email: `${unique()}@example.com` });

    expect(failing.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect(failing.body.message).toBe(unknown.body.message);
    expect(failing.body._dev_token).toBeUndefined();
  });

  it("DEV_SHOW_RESET_TOKEN can NEVER expose a token when NODE_ENV=production", async () => {
    process.env["DEV_SHOW_RESET_TOKEN"] = "true";
    process.env["NODE_ENV"] = "production";

    const res = await request(app).post("/api/auth/forgot-password").send({ email });

    expect(res.status).toBe(200);
    expect(res.body._dev_token).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toMatch(/[0-9a-f]{64}/);
  });

  it("DEV_SHOW_RESET_TOKEN still works in non-production", async () => {
    process.env["DEV_SHOW_RESET_TOKEN"] = "true";
    // NODE_ENV remains "test" (non-production)

    const res = await request(app).post("/api/auth/forgot-password").send({ email });

    expect(res.status).toBe(200);
    expect(res.body._dev_token).toBeDefined();
    expect(res.body._dev_token).toMatch(/^[0-9a-f]{64}$/);
  });
});
