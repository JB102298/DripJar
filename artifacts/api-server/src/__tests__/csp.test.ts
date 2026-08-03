/**
 * Phase 3A: production Content-Security-Policy behavior.
 *
 * buildHelmetOptions(isProduction) is the exact option builder used by
 * app.ts. We mount it on minimal Express apps to verify:
 *  - production: restrictive CSP header present
 *  - development: no CSP header (previews/Expo tooling unaffected)
 *  - crossOriginEmbedderPolicy stays disabled in both modes
 */
import { describe, it, expect } from "vitest";
import express from "express";
import helmet from "helmet";
import request from "supertest";
import { buildHelmetOptions } from "../app.js";

function makeApp(isProduction: boolean) {
  const app = express();
  app.use(helmet(buildHelmetOptions(isProduction)));
  app.get("/ping", (_req, res) => void res.json({ ok: true }));
  return app;
}

describe("Content-Security-Policy", () => {
  it("is enabled with restrictive directives in production", async () => {
    const res = await request(makeApp(true)).get("/ping");
    const csp = res.headers["content-security-policy"];
    expect(csp).toBeDefined();
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("form-action 'none'");
  });

  it("is NOT applied in development configuration", async () => {
    const res = await request(makeApp(false)).get("/ping");
    expect(res.headers["content-security-policy"]).toBeUndefined();
  });

  it("keeps crossOriginEmbedderPolicy disabled in both modes", async () => {
    const prod = await request(makeApp(true)).get("/ping");
    const dev = await request(makeApp(false)).get("/ping");
    expect(prod.headers["cross-origin-embedder-policy"]).toBeUndefined();
    expect(dev.headers["cross-origin-embedder-policy"]).toBeUndefined();
  });
});
