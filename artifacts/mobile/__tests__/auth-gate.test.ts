/**
 * Phase 3A: navigation auth-gate rules.
 *
 * Signed-out users must be able to open deep links from emails:
 *  - /invite/{token}
 *  - /reset-password/{token}
 * while all other routes redirect to the auth group.
 */
import { describe, it, expect } from "vitest";
import { isPublicRoute } from "../lib/auth-gate";

describe("isPublicRoute (signed-out navigation gate)", () => {
  it("allows the auth group", () => {
    expect(isPublicRoute("(auth)")).toBe(true);
  });

  it("allows invitation links", () => {
    expect(isPublicRoute("invite")).toBe(true);
  });

  it("allows password-reset email links", () => {
    expect(isPublicRoute("reset-password")).toBe(true);
  });

  it("allows email-verification links", () => {
    expect(isPublicRoute("verify-email")).toBe(true);
  });

  it("redirects everything else", () => {
    expect(isPublicRoute("(tabs)")).toBe(false);
    expect(isPublicRoute("jar")).toBe(false);
    expect(isPublicRoute("create-jar")).toBe(false);
    expect(isPublicRoute(undefined)).toBe(false);
  });
});
