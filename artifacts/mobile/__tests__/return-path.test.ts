/**
 * Phase 2: returnTo sanitizer — only in-app absolute paths survive.
 * Anything that could redirect off-app (external URLs, protocol-relative,
 * schemes, backslashes) is rejected.
 */
import { describe, it, expect } from "vitest";
import { sanitizeReturnPath } from "../lib/return-path";

describe("sanitizeReturnPath", () => {
  it("accepts simple in-app paths", () => {
    expect(sanitizeReturnPath("/invite/abc123")).toBe("/invite/abc123");
    expect(sanitizeReturnPath("/jar/42")).toBe("/jar/42");
    expect(sanitizeReturnPath("/")).toBe("/");
  });

  it("rejects non-strings and empty values", () => {
    expect(sanitizeReturnPath(undefined)).toBeNull();
    expect(sanitizeReturnPath(null)).toBeNull();
    expect(sanitizeReturnPath(42)).toBeNull();
    expect(sanitizeReturnPath(["/a", "/b"])).toBeNull();
    expect(sanitizeReturnPath("")).toBeNull();
  });

  it("rejects relative paths", () => {
    expect(sanitizeReturnPath("invite/abc")).toBeNull();
    expect(sanitizeReturnPath("../secrets")).toBeNull();
  });

  it("rejects protocol-relative URLs", () => {
    expect(sanitizeReturnPath("//evil.com/phish")).toBeNull();
  });

  it("rejects absolute URLs and embedded schemes", () => {
    expect(sanitizeReturnPath("https://evil.com")).toBeNull();
    expect(sanitizeReturnPath("/redirect?to=https://evil.com")).toBeNull();
    expect(sanitizeReturnPath("javascript://alert(1)")).toBeNull();
  });

  it("rejects backslash tricks", () => {
    expect(sanitizeReturnPath("/\\evil.com")).toBeNull();
    expect(sanitizeReturnPath("\\\\evil.com")).toBeNull();
  });
});
