/**
 * Legal link configuration tests.
 *
 * DripJar does not ship legal text — Privacy Policy and Terms of Service are
 * external documents linked by URL. These tests pin the two properties that
 * matter for release safety:
 *
 *   1. Nothing is invented. With no environment configuration the links report
 *      themselves as unconfigured and carry no URL, so the UI shows them as
 *      unavailable instead of opening a fabricated or dead page.
 *   2. Only an absolute http(s) URL counts as configured, so a partially-set
 *      or malformed value can never be handed to the OS URL opener.
 */

import { describe, it, expect } from "vitest";
import {
  __buildLegalLink,
  privacyPolicyLink,
  termsOfServiceLink,
  PRIVACY_POLICY_ENV_VAR,
  TERMS_OF_SERVICE_ENV_VAR,
} from "../constants/legal";

describe("legal link validation", () => {
  const accepted = [
    "https://thedripjar.com/privacy",
    "http://localhost:3000/terms",
    "https://example.com/a/b?c=d#e",
    "HTTPS://UPPERCASE.EXAMPLE/privacy",
  ];

  for (const url of accepted) {
    it(`accepts absolute URL: ${url}`, () => {
      const link = __buildLegalLink(url, "SOME_VAR");
      expect(link.configured).toBe(true);
      expect(link.url).toBe(url);
    });
  }

  const rejected: Array<[string, string | undefined]> = [
    ["undefined", undefined],
    ["empty string", ""],
    ["whitespace only", "   "],
    ["relative path", "/privacy"],
    ["bare domain without scheme", "thedripjar.com/privacy"],
    ["unsupported scheme", "ftp://example.com/privacy"],
    ["javascript scheme", "javascript:alert(1)"],
    ["scheme with no host", "https://"],
  ];

  for (const [label, value] of rejected) {
    it(`treats ${label} as unconfigured`, () => {
      const link = __buildLegalLink(value, "SOME_VAR");
      expect(link.configured).toBe(false);
      // An unconfigured link must expose no URL at all, so a caller cannot
      // accidentally open a partially-valid value.
      expect(link.url).toBe("");
    });
  }

  it("trims surrounding whitespace from a valid URL", () => {
    const link = __buildLegalLink("  https://example.com/terms  ", "SOME_VAR");
    expect(link.configured).toBe(true);
    expect(link.url).toBe("https://example.com/terms");
  });

  it("always reports the environment variable name, configured or not", () => {
    expect(__buildLegalLink(undefined, "MY_VAR").envVar).toBe("MY_VAR");
    expect(__buildLegalLink("https://example.com", "MY_VAR").envVar).toBe("MY_VAR");
  });
});

describe("exported legal links", () => {
  it("expose the expected environment variable names", () => {
    expect(privacyPolicyLink.envVar).toBe(PRIVACY_POLICY_ENV_VAR);
    expect(termsOfServiceLink.envVar).toBe(TERMS_OF_SERVICE_ENV_VAR);
    expect(PRIVACY_POLICY_ENV_VAR).toBe("EXPO_PUBLIC_PRIVACY_POLICY_URL");
    expect(TERMS_OF_SERVICE_ENV_VAR).toBe("EXPO_PUBLIC_TERMS_OF_SERVICE_URL");
  });

  it("carry no URL unless explicitly configured", () => {
    // No fabricated default may ever ship. If these env vars are unset in the
    // test environment (the norm), both links must be inert.
    for (const link of [privacyPolicyLink, termsOfServiceLink]) {
      if (!link.configured) {
        expect(link.url).toBe("");
      } else {
        expect(link.url).toMatch(/^https?:\/\/\S+$/i);
      }
    }
  });
});
