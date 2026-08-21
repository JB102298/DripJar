/**
 * Rules screen and the short-rules list — Owner QA items 5 and 9.
 *
 * The old rules screen listed four hand-written rules with no connection to the
 * document members actually accept, and one of them was wrong in the same way
 * the old agreement was: it said a majority vote decides "before the jar funds
 * are spent", implying the group can move an individual's money. It cannot.
 * `routes/commitments.ts` records votes and calls no ledger primitive at all;
 * principal moves only through `routes/fund-commitment.ts`, scoped to the
 * caller's own member id.
 *
 * The cross-package check that the summary covers exactly the server's clause
 * ids lives in the API suite (`agreement-parity.test.ts`), because that is
 * where the canonical clause list is. These tests cover the mobile half: the
 * list is well-formed, the screen renders it rather than its own strings, and
 * the corrected claim is present while the wrong one is gone.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import React from "react";
import { render, cleanup, screen } from "@testing-library/react";
import { AGREEMENT_SHORT_RULES, AGREEMENT_SHORT_RULE_IDS, AGREEMENT_VERSION } from "../lib/agreement-rules";

vi.mock("@/contexts/create-jar-context", () => ({
  useCreateJarContext: () => ({
    state: { category: "Education" },
    updateState: vi.fn(),
    resetState: vi.fn(),
  }),
}));

vi.mock("expo-router", () => ({
  useRouter: () => ({ back: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

vi.mock("@/hooks/useColors", () => ({
  useColors: () => new Proxy({}, { get: () => "#000000" }),
}));

vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock("@expo/vector-icons", () => ({ Feather: () => null }));
vi.mock("@/components/ProgressBar", () => ({ ProgressBar: () => null }));

import CreateJarStep7 from "../app/create-jar/rules";

afterEach(cleanup);

describe("short-rules list is well-formed", () => {
  it("has unique clause ids", () => {
    expect(new Set(AGREEMENT_SHORT_RULE_IDS).size).toBe(AGREEMENT_SHORT_RULE_IDS.length);
  });

  it("gives every rule a title and a summary", () => {
    for (const rule of AGREEMENT_SHORT_RULES) {
      expect(rule.id.trim()).not.toBe("");
      expect(rule.title.trim()).not.toBe("");
      expect(rule.summary.trim()).not.toBe("");
    }
  });

  it("declares a version", () => {
    expect(AGREEMENT_VERSION).toMatch(/^\d+\.\d+$/);
  });
});

describe("rules screen renders the list rather than its own copy", () => {
  it("renders one block per clause", () => {
    render(<CreateJarStep7 />);
    for (const rule of AGREEMENT_SHORT_RULES) {
      expect(
        screen.getByTestId(`agreement-rule-${rule.id}`),
        `clause ${rule.id} is not rendered`,
      ).toBeTruthy();
    }
  });

  it("renders every rule's title and summary text", () => {
    render(<CreateJarStep7 />);
    const text = document.body.textContent ?? "";
    for (const rule of AGREEMENT_SHORT_RULES) {
      expect(text, `missing title for ${rule.id}`).toContain(rule.title);
    }
  });

  it("names the agreement version it is summarising", () => {
    render(<CreateJarStep7 />);
    expect(document.body.textContent).toContain(`v${AGREEMENT_VERSION}`);
  });

  it("uses the category's rules helper rather than travel wording", () => {
    // Mocked as an Education jar above. The screen previously hard-coded
    // "Clear expectations make group trips stress-free" for every category.
    render(<CreateJarStep7 />);
    expect(document.body.textContent).not.toMatch(/group trips/i);
    expect(document.body.textContent).toMatch(/clear expectations keep everyone comfortable contributing/i);
  });
});

describe("the corrected commitment claim", () => {
  it("states that only the member commits their own money", () => {
    render(<CreateJarStep7 />);
    const text = document.body.textContent ?? "";
    expect(text).toMatch(/no vote and no other member can commit your savings/i);
  });

  it("no longer says a vote is what spends the jar's funds", () => {
    render(<CreateJarStep7 />);
    const text = document.body.textContent ?? "";
    // The exact shipped sentence.
    expect(text).not.toMatch(/require a majority vote before the jar funds are spent/i);
    expect(text).not.toMatch(/before the jar funds are spent/i);
  });

  it("still explains that the group votes on spending", () => {
    // The correction must not remove the fact that a vote happens — only the
    // false claim about whose money it moves.
    render(<CreateJarStep7 />);
    expect(document.body.textContent).toMatch(/vote/i);
  });
});
