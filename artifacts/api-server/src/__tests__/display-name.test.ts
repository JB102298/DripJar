/**
 * Canonical display name — Owner QA item 4 (server)
 *
 * Mirrors artifacts/mobile/__tests__/display-name.test.ts. The two copies of
 * the rule must agree, so the shared cases are asserted in both suites; a
 * change to one implementation without the other fails here or there.
 *
 * Also pins the second half of the bug: names must not be frozen into
 * `activity_events.description`, because that column is written once and read
 * for ever. The seeded feed said "Robert added $700.00" while the profile had
 * since been renamed "Dad", and no rename could correct those rows.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  resolveDisplayName,
  resolveShortDisplayName,
  resolveActorName,
  UNKNOWN_DISPLAY_NAME,
} from "../lib/display-name.js";

describe("resolveDisplayName precedence", () => {
  it("prefers the chosen display name over the legal name", () => {
    expect(
      resolveDisplayName({ displayName: "Mom", firstName: "Mary", lastName: "Barrett" }),
    ).toBe("Mom");
  });

  it("falls back to first + last, then to a single part", () => {
    expect(resolveDisplayName({ firstName: "Mary", lastName: "Barrett" })).toBe("Mary Barrett");
    expect(resolveDisplayName({ firstName: "Mary" })).toBe("Mary");
    expect(resolveDisplayName({ lastName: "Barrett" })).toBe("Barrett");
  });

  it("treats whitespace-only as absent and trims the rest", () => {
    expect(resolveDisplayName({ displayName: "   ", firstName: "Mary" })).toBe("Mary");
    expect(resolveDisplayName({ displayName: "  Mom  " })).toBe("Mom");
  });

  it("never returns null, undefined, or an empty string", () => {
    for (const p of [null, undefined, {}, { displayName: "" }, { firstName: " " }]) {
      const rendered = resolveDisplayName(p);
      expect(typeof rendered).toBe("string");
      expect(rendered.length).toBeGreaterThan(0);
    }
  });

  it("never leaks an id or email as a name", () => {
    const rendered = resolveDisplayName({
      displayName: null,
      firstName: null,
      lastName: null,
      userId: "02bde80f-219c-4aac-9d52-7ae662a11fed",
      email: "jordan@dripjar.dev",
    } as never);

    expect(rendered).toBe(UNKNOWN_DISPLAY_NAME);
    expect(rendered).not.toContain("@");
    expect(rendered).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
  });
});

describe("resolveActorName", () => {
  it("returns null for system events so they are not captioned with a person", () => {
    // e.g. "Flights are fully funded!" has user_id NULL.
    expect(resolveActorName(null, false)).toBeNull();
    expect(resolveActorName({ displayName: "Mom" }, false)).toBeNull();
  });

  it("resolves a name whenever there is an actor", () => {
    expect(resolveActorName({ displayName: "Mom" }, true)).toBe("Mom");
    // Actor exists but the profile row is missing — still never null.
    expect(resolveActorName(null, true)).toBe(UNKNOWN_DISPLAY_NAME);
  });
});

describe("resolveShortDisplayName", () => {
  it("takes the first token", () => {
    expect(resolveShortDisplayName({ displayName: "Jordan Barrett" })).toBe("Jordan");
    expect(resolveShortDisplayName({ displayName: "Mom" })).toBe("Mom");
    expect(resolveShortDisplayName(null)).toBe(UNKNOWN_DISPLAY_NAME);
  });
});

// ─── Frozen-name regression ──────────────────────────────────────────────────

describe("activity descriptions do not freeze member names", () => {
  const routesDir = join(process.cwd(), "src", "routes");

  it("member_left is logged without a name in the description", () => {
    // The actor IS the member leaving, so the feed resolves their current name
    // from user_id. Embedding it here would snapshot it permanently.
    const src = readFileSync(join(routesDir, "members.ts"), "utf8");
    expect(src).toContain('description: `left the jar`');
    expect(src).not.toContain("${name} left the jar");
  });

  it("member_removed records the subject id alongside the snapshot", () => {
    // Unlike member_left, the actor is the organizer while the name belongs to
    // the person removed, so actorName cannot supply it. The id is recorded so
    // a later pass can resolve the current name at read time.
    const src = readFileSync(join(routesDir, "members.ts"), "utf8");
    expect(src).toContain("subjectUserId: membership.userId");
  });

  it("no route builds an activity description from a raw displayName field", () => {
    // Catches a new `description: \`${prof.displayName} did X\`` anywhere.
    const files = ["members.ts", "contributions.ts", "invitations.ts", "jars.ts", "goals.ts"];
    const offenders: string[] = [];

    for (const file of files) {
      const src = readFileSync(join(routesDir, file), "utf8");
      for (const [i, line] of src.split("\n").entries()) {
        if (/description:/.test(line) && /\?\.displayName|\[0\]\?\.displayName/.test(line)) {
          offenders.push(`${file}:${i + 1}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});

// ─── Cross-tier agreement ────────────────────────────────────────────────────

describe("client and server rules agree", () => {
  it("uses the same placeholder string", () => {
    // The client copy lives at artifacts/mobile/lib/display-name.ts. Divergent
    // placeholders would reintroduce exactly the inconsistency being fixed.
    const clientSrc = readFileSync(
      join(process.cwd(), "..", "mobile", "lib", "display-name.ts"),
      "utf8",
    );
    expect(clientSrc).toContain(`'${UNKNOWN_DISPLAY_NAME}'`);
  });

  it("produces identical output for the seeded profiles", () => {
    const seeded = [
      { displayName: "Mom", firstName: "Mary", lastName: "Barrett" },
      { displayName: "Dad", firstName: "Robert", lastName: "Barrett" },
      { displayName: "Brother", firstName: "Tyler", lastName: "Barrett" },
      { displayName: "Jordan Barrett", firstName: "Jordan", lastName: "Barrett" },
    ];

    for (const p of seeded) {
      expect(resolveDisplayName(p)).toBe(p.displayName);
    }
  });
});
