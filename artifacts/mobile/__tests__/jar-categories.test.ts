/**
 * Centralised category model — Owner QA items 6 and 7.
 *
 * Two failures are being guarded against.
 *
 * The first is copy: seventeen travel-specific strings across seven files, in a
 * product whose category list now includes emergency funds and college funds.
 * These tests assert that no non-travel category carries travel wording, which
 * is a property of the data rather than of any one screen — so it stays true as
 * screens are added.
 *
 * The second is resilience: `jars.category` is nullable free text written with
 * no server-side enum validation, so unrecognised values genuinely reach the
 * client. `resolveCategory` must always return something renderable.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CreateJarRequestCategory } from "@workspace/api-client-react";
import {
  CATEGORY_CONFIGS,
  CATEGORY_GROUP_ORDER,
  OTHER_CATEGORY,
  categoriesInGroup,
  categoryLabel,
  isKnownCategory,
  resolveCategory,
  type CategoryConfig,
} from "../lib/jar-categories";

/** Categories whose copy is allowed to talk about trips. */
const TRAVEL_CATEGORY_IDS = ["Vacation", "Cruise", "MissionTrip", "Honeymoon"];

/**
 * Framing wording that presumes the jar is a trip.
 *
 * This is the class of string the pass exists to remove: headings, labels, and
 * help text that told an emergency-fund organizer their savings were for a
 * "trip" with a "takeoff".
 */
const TRAVEL_FRAMING = /\b(trip|trips|takeoff|flight|flights|itinerary|sail|sails|cruise|airfare|destination|travel|travelling|traveling)\b/i;

/**
 * Milestone names that are unambiguously travel purchases.
 *
 * Deliberately narrower than TRAVEL_FRAMING. "Travel" and "Lodging" are
 * perfectly sensible milestones for a family reunion or a college fund — the
 * bug was never that non-travel jars mention travel costs, it was that every
 * jar was *described* as a trip.
 */
const TRAVEL_ONLY_PURCHASES = /\b(flight|flights|airfare|itinerary|cabin|excursion|excursions|takeoff)\b/i;

/** The headings, labels, and help text a user reads while creating the jar. */
function framingCopy(config: CategoryConfig): string {
  const parts: string[] = [
    config.label,
    config.namePlaceholder,
    config.descriptionPlaceholder,
    config.dateHeading,
    config.targetDateLabel,
    config.targetDateHelp,
    config.milestoneHelp,
    config.rulesHelper,
    config.reviewTitle,
    config.reviewSubtitle,
  ];
  if (config.locationField) {
    parts.push(
      config.locationField.label,
      config.locationField.placeholder,
      config.locationField.reviewLabel,
    );
  }
  if (config.eventWindow) {
    parts.push(
      config.eventWindow.startLabel,
      config.eventWindow.startPlaceholder,
      config.eventWindow.endLabel,
      config.eventWindow.endPlaceholder,
      config.eventWindow.targetAfterStartError,
    );
  }
  return parts.join(" | ");
}

describe("catalogue shape", () => {
  it("has exactly the fifteen catalogued categories", () => {
    expect(CATEGORY_CONFIGS).toHaveLength(15);
  });

  it("has unique ids", () => {
    const ids = CATEGORY_CONFIGS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("matches the OpenAPI enum exactly", () => {
    // Mirrors lib/api-spec/openapi.yaml. A category added on one side and not
    // the other produces a value the UI cannot render or an option the server
    // has never heard of.
    expect(CATEGORY_CONFIGS.map((c) => c.id).sort()).toEqual(
      [
        "BusinessProject", "Celebration", "Cruise", "Education", "EmergencyFund",
        "FamilyGoal", "HomeDownPayment", "Honeymoon", "LargePurchase", "MissionTrip",
        "Other", "Reunion", "Vacation", "Vehicle", "Wedding",
      ].sort(),
    );
  });

  it("assigns every category to a rendered group", () => {
    for (const config of CATEGORY_CONFIGS) {
      expect(CATEGORY_GROUP_ORDER).toContain(config.group);
    }
    // Every group must actually render something, or the picker shows an
    // empty heading.
    for (const group of CATEGORY_GROUP_ORDER) {
      expect(categoriesInGroup(group).length).toBeGreaterThan(0);
    }
  });

  it("leaves no copy field blank", () => {
    for (const config of CATEGORY_CONFIGS) {
      for (const [key, value] of Object.entries(config)) {
        if (typeof value === "string") {
          expect(value.trim(), `${config.id}.${key} is empty`).not.toBe("");
        }
      }
      expect(config.milestoneSuggestions.length, `${config.id} has no milestone suggestions`)
        .toBeGreaterThan(0);
    }
  });
});

describe("category-appropriate copy", () => {
  it("keeps travel framing out of non-travel categories", () => {
    for (const config of CATEGORY_CONFIGS) {
      if (TRAVEL_CATEGORY_IDS.includes(config.id)) continue;
      const match = TRAVEL_FRAMING.exec(framingCopy(config));
      expect(
        match?.[0],
        `${config.id} carries travel framing: "${match?.[0]}"`,
      ).toBeUndefined();
    }
  });

  it("suggests no travel-only purchases for non-travel categories", () => {
    for (const config of CATEGORY_CONFIGS) {
      if (TRAVEL_CATEGORY_IDS.includes(config.id)) continue;
      const match = TRAVEL_ONLY_PURCHASES.exec(config.milestoneSuggestions.join(" | "));
      expect(
        match?.[0],
        `${config.id} suggests a travel-only milestone: "${match?.[0]}"`,
      ).toBeUndefined();
    }
  });

  it("still speaks naturally about travel where it applies", () => {
    // The fix is category-awareness, not the removal of all specificity — a
    // vacation jar should still say "trip".
    expect(resolveCategory("Vacation").dateHeading).toMatch(/trip/i);
    expect(resolveCategory("Cruise").dateHeading).toMatch(/sail/i);
  });

  it("offers no place field where a place is meaningless", () => {
    expect(resolveCategory("EmergencyFund").locationField).toBeNull();
    expect(resolveCategory("Vehicle").locationField).toBeNull();
    expect(resolveCategory("LargePurchase").locationField).toBeNull();
    expect(resolveCategory("FamilyGoal").locationField).toBeNull();
  });

  it("offers an event window only where there is an event", () => {
    expect(resolveCategory("Vacation").eventWindow).not.toBeNull();
    expect(resolveCategory("Wedding").eventWindow).not.toBeNull();
    // An emergency fund is never "on" a date.
    expect(resolveCategory("EmergencyFund").eventWindow).toBeNull();
    expect(resolveCategory("Education").eventWindow).toBeNull();
  });
});

describe("date precision defaults", () => {
  it("opens long-horizon goals at a coarse precision", () => {
    // A newborn's college fund is eighteen years out. Asking for an exact day
    // implies a certainty the organizer does not have.
    expect(resolveCategory("Education").defaultTargetPrecision).toBe("year");
  });

  it("opens dated events at an exact day", () => {
    expect(resolveCategory("Vacation").defaultTargetPrecision).toBe("exact");
    expect(resolveCategory("Cruise").defaultTargetPrecision).toBe("exact");
  });
});

describe("Other is the safe fallback", () => {
  it("resolves null and undefined", () => {
    expect(resolveCategory(null)).toBe(OTHER_CATEGORY);
    expect(resolveCategory(undefined)).toBe(OTHER_CATEGORY);
  });

  it("resolves the empty string", () => {
    expect(resolveCategory("")).toBe(OTHER_CATEGORY);
  });

  it("resolves values this build has never heard of", () => {
    // Rows like these exist: the column is free text and predates the list.
    expect(resolveCategory("GroupTrip")).toBe(OTHER_CATEGORY);
    expect(resolveCategory("Sabbatical")).toBe(OTHER_CATEGORY);
    expect(resolveCategory("vacation")).toBe(OTHER_CATEGORY); // case-sensitive by design
  });

  it("never returns undefined for any input", () => {
    for (const input of [null, undefined, "", " ", "Vacation", "nonsense", "0"]) {
      expect(resolveCategory(input)).toBeDefined();
      expect(typeof categoryLabel(input)).toBe("string");
    }
  });

  it("reports which values are catalogued", () => {
    expect(isKnownCategory("Vacation")).toBe(true);
    expect(isKnownCategory("EmergencyFund")).toBe(true);
    expect(isKnownCategory("GroupTrip")).toBe(false);
    expect(isKnownCategory(null)).toBe(false);
  });

  it("gives Other copy that reads correctly for an unanticipated goal", () => {
    // This record is what an unknown value renders as, so it must not assume
    // anything about the goal.
    expect(framingCopy(OTHER_CATEGORY)).not.toMatch(TRAVEL_FRAMING);
    expect(OTHER_CATEGORY.milestoneSuggestions.join(" ")).not.toMatch(TRAVEL_ONLY_PURCHASES);
    expect(OTHER_CATEGORY.eventWindow).toBeNull();
  });
});

describe("the mobile catalogue matches the API write contract", () => {
  it("offers exactly the categories the server will accept on create", () => {
    // `CreateJarRequestCategory` is generated from the CreateJarRequest enum in
    // lib/api-spec/openapi.yaml, which the server enforces with a 400. A
    // category offered in the picker but absent from that enum would be a
    // create button that always fails; one present in the enum but missing here
    // would be a category no user can reach.
    expect(Object.keys(CreateJarRequestCategory).sort()).toEqual(
      CATEGORY_CONFIGS.map((c) => c.id).sort(),
    );
  });

  it("keeps the read side deliberately untyped", () => {
    // Jar.category is an open string in the spec, because legacy rows carry
    // values outside the list. If a `JarCategory` union ever reappears in the
    // generated schemas, the contract has started claiming something false and
    // `resolveCategory` would be lying about being necessary.
    const schemas = readFileSync(
      join(__dirname, "../../../lib/api-client-react/src/generated/api.schemas.ts"),
      "utf-8",
    );
    expect(schemas).not.toMatch(/export const JarCategory = \{/);
  });
});
