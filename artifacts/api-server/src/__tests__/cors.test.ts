import { describe, it, expect, afterEach, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import cors from "cors";

/**
 * Builds a minimal Express app with exact-match CORS, mirroring app.ts logic.
 */
function buildApp(allowedOrigins: string[]) {
  const originSet = new Set(
    allowedOrigins.map((o) => {
      const normalized = new URL(o).origin;
      return normalized;
    }),
  );

  const app = express();
  app.use(
    cors({
      origin: (incomingOrigin, callback) => {
        if (!incomingOrigin) { callback(null, true); return; }
        if (originSet.has(incomingOrigin)) {
          callback(null, true);
        } else {
          callback(new Error("Not allowed by CORS"));
        }
      },
      credentials: true,
    }),
  );
  app.get("/test", (_req, res) => res.json({ ok: true }));
  return app;
}

describe("CORS exact origin matching", () => {
  const app = buildApp(["https://thedripjar.com", "https://www.thedripjar.com"]);

  it("allows https://thedripjar.com when configured", async () => {
    const res = await request(app)
      .get("/test")
      .set("Origin", "https://thedripjar.com");
    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe("https://thedripjar.com");
  });

  it("allows https://www.thedripjar.com when separately configured", async () => {
    const res = await request(app)
      .get("/test")
      .set("Origin", "https://www.thedripjar.com");
    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe("https://www.thedripjar.com");
  });

  it("rejects https://thedripjar.com.evil.example (subdomain attack)", async () => {
    const res = await request(app)
      .get("/test")
      .set("Origin", "https://thedripjar.com.evil.example");
    // CORS policy should deny — access-control-allow-origin should be absent
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("rejects https://evilthedripjar.com (prefix match attack)", async () => {
    const res = await request(app)
      .get("/test")
      .set("Origin", "https://evilthedripjar.com");
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("allows requests with no Origin header (native mobile / server-to-server)", async () => {
    const res = await request(app).get("/test");
    expect(res.status).toBe(200);
  });
});
