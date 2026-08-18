/**
 * Canonical display name — Owner QA item 4
 *
 * Home and Members showed "Mom", "Dad", "Brother" while Activity showed
 * "Mary", "Robert", "Tyler" for the same people.
 *
 * Two causes. First, no shared rule: the server had six different fallbacks
 * for one concept ("A member", "Unknown", "A DripJar member", "Someone", null,
 * and a raw field), and the client had five more, one of which rendered the
 * literal string "undefined undefined" for a partially loaded profile.
 * Second, names were frozen into `activity_events.description` at write time,
 * so the seeded history said "Robert" while the profile had since been renamed
 * "Dad" — no rename could ever fix those rows.
 *
 * These tests pin the rule. The client copy must stay identical to
 * artifacts/api-server/src/lib/display-name.ts; the shared cases below are
 * duplicated in the API suite so a change to one without the other fails.
 */
import { describe, it, expect } from "vitest";
import {
  resolveDisplayName,
  shortDisplayName,
  greetingName,
  UNKNOWN_DISPLAY_NAME,
} from "../lib/display-name";

describe("resolveDisplayName precedence", () => {
  it("prefers the chosen display name", () => {
    // "Mom" is a deliberate choice, not a data problem. Home was right.
    expect(
      resolveDisplayName({ displayName: "Mom", firstName: "Mary", lastName: "Barrett" }),
    ).toBe("Mom");
  });

  it("falls back to first + last when no display name is set", () => {
    expect(resolveDisplayName({ displayName: null, firstName: "Mary", lastName: "Barrett" })).toBe(
      "Mary Barrett",
    );
  });

  it("uses whichever single part exists", () => {
    expect(resolveDisplayName({ firstName: "Mary" })).toBe("Mary");
    expect(resolveDisplayName({ lastName: "Barrett" })).toBe("Barrett");
  });

  it("never renders 'undefined undefined' for a partially loaded profile", () => {
    // `${profile?.firstName} ${profile?.lastName}` produced exactly that.
    const rendered = resolveDisplayName({ displayName: null });
    expect(rendered).toBe(UNKNOWN_DISPLAY_NAME);
    expect(rendered).not.toContain("undefined");
  });

  it("treats whitespace-only values as absent", () => {
    expect(resolveDisplayName({ displayName: "   ", firstName: "Mary" })).toBe("Mary");
    expect(resolveDisplayName({ displayName: "\t\n", firstName: " ", lastName: " " })).toBe(
      UNKNOWN_DISPLAY_NAME,
    );
  });

  it("trims surrounding whitespace", () => {
    expect(resolveDisplayName({ displayName: "  Mom  " })).toBe("Mom");
    expect(resolveDisplayName({ firstName: " Mary ", lastName: " Barrett " })).toBe("Mary Barrett");
  });

  it("handles null and undefined profiles", () => {
    expect(resolveDisplayName(null)).toBe(UNKNOWN_DISPLAY_NAME);
    expect(resolveDisplayName(undefined)).toBe(UNKNOWN_DISPLAY_NAME);
    expect(resolveDisplayName({})).toBe(UNKNOWN_DISPLAY_NAME);
  });

  it("never returns an empty string", () => {
    const profiles = [
      null,
      undefined,
      {},
      { displayName: "" },
      { displayName: "  " },
      { firstName: "", lastName: "" },
    ];
    for (const p of profiles) {
      expect(resolveDisplayName(p).length).toBeGreaterThan(0);
    }
  });
});

describe("no internal identifiers leak into names", () => {
  it("does not fall back to an id or email even when present on the object", () => {
    const profile = {
      displayName: null,
      firstName: null,
      lastName: null,
      // Deliberately present: a naive fallback would reach for these.
      userId: "02bde80f-219c-4aac-9d52-7ae662a11fed",
      email: "jordan@dripjar.dev",
    } as never;

    const rendered = resolveDisplayName(profile);
    expect(rendered).toBe(UNKNOWN_DISPLAY_NAME);
    expect(rendered).not.toContain("@");
    expect(rendered).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
  });
});

describe("shortDisplayName", () => {
  it("takes the first token of the canonical name", () => {
    expect(shortDisplayName({ displayName: "Jordan Barrett" })).toBe("Jordan");
    expect(shortDisplayName({ displayName: "Mom" })).toBe("Mom");
  });

  it("accepts an already-resolved string from the API", () => {
    expect(shortDisplayName("Jordan Barrett")).toBe("Jordan");
    expect(shortDisplayName("Mom")).toBe("Mom");
  });

  it("survives the inputs that broke the inline .split(' ')[0]", () => {
    // `displayName.split(' ')[0]` threw on null and returned "" for a leading space.
    expect(shortDisplayName(null)).toBe(UNKNOWN_DISPLAY_NAME);
    expect(shortDisplayName(undefined)).toBe(UNKNOWN_DISPLAY_NAME);
    expect(shortDisplayName("")).toBe(UNKNOWN_DISPLAY_NAME);
    expect(shortDisplayName("  Jordan Barrett")).toBe("Jordan");
    expect(shortDisplayName("Jordan   Barrett")).toBe("Jordan");
  });
});

describe("greetingName", () => {
  it("uses the first name so the greeting stays personal", () => {
    expect(greetingName({ firstName: "Jordan", displayName: "Jordan Barrett" })).toBe("Jordan");
  });

  it("falls back to the first token of the display name", () => {
    expect(greetingName({ firstName: null, displayName: "Mom" })).toBe("Mom");
  });

  it("never greets someone as 'A DripJar member'", () => {
    // The generic placeholder is right in a member list and wrong in a greeting.
    expect(greetingName(null)).toBe("there");
    expect(greetingName({})).toBe("there");
    expect(greetingName(null)).not.toBe(UNKNOWN_DISPLAY_NAME);
  });

  it("accepts a caller-supplied fallback", () => {
    expect(greetingName(null, "friend")).toBe("friend");
  });
});

describe("the reported Mom/Mary divergence", () => {
  // The seeded profiles that produced the bug.
  const seeded = [
    { displayName: "Mom", firstName: "Mary", lastName: "Barrett" },
    { displayName: "Dad", firstName: "Robert", lastName: "Barrett" },
    { displayName: "Brother", firstName: "Tyler", lastName: "Barrett" },
    { displayName: "Jordan Barrett", firstName: "Jordan", lastName: "Barrett" },
  ];

  it("every surface resolves the same name for the same person", () => {
    // Home, Members, and Activity all call this one function now, so the only
    // way they can disagree is if one of them stops calling it.
    for (const p of seeded) {
      expect(resolveDisplayName(p)).toBe(p.displayName);
    }
  });

  it("does not surface the real first name when a nickname is set", () => {
    expect(resolveDisplayName(seeded[0]!)).not.toBe("Mary");
    expect(resolveDisplayName(seeded[1]!)).not.toBe("Robert");
    expect(resolveDisplayName(seeded[2]!)).not.toBe("Tyler");
  });
});
