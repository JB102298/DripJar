/**
 * Contribution History loads additional pages — remediation item 3.
 *
 * The API side proves the cursor chain is correct at volume. This proves the
 * screen actually follows it, and — more importantly — that it tells the reader
 * which of two numbers is on screen.
 *
 * That last point is the subtle one. `summary` spans the caller's whole ledger
 * history while the rows are one page of it, so until every page is loaded the
 * list genuinely does not add up to the headline. Saying so is the difference
 * between a partial view and an apparent accounting error; the previous version
 * of this screen had a `truncated` flag for exactly this reason, and
 * paginating does not remove the obligation, it just changes when it ends.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import React from "react";
import { render, cleanup, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const { listMyContributions } = vi.hoisted(() => ({
  listMyContributions: vi.fn(),
}));

vi.mock("@workspace/api-client-react", () => ({ listMyContributions }));

vi.mock("expo-router", () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), replace: vi.fn() }),
}));

vi.mock("@/hooks/useColors", () => ({
  useColors: () => new Proxy({}, { get: () => "#000000" }),
}));

vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock("@expo/vector-icons", () => ({ Feather: () => null }));

import ContributionHistoryScreen from "../app/history/contributions";

const SUMMARY = {
  lifetimeContributedPrincipalCents: 60_000,
  currentlySavedPrincipalCents: 60_000,
  refundedPrincipalCents: 0,
  jarCount: 1,
  contributionCount: 6,
  reconciles: true,
};

/** Three rows per page, two pages, six rows total. */
function page(index: number, nextCursor: string | null) {
  return {
    summary: SUMMARY,
    contributions: [0, 1, 2].map((i) => ({
      jarId: "jar-1",
      jarName: `Jar ${index * 3 + i}`,
      principalCents: 10_000,
      currency: "USD",
      transactionType: i % 2 === 0 ? "contribution" : "autodrip_contribution",
      occurredAt: `2026-0${index + 1}-0${i + 1}T00:00:00.000Z`,
    })),
    pageInfo: {
      hasMore: nextCursor !== null,
      nextCursor,
      limit: 3,
      totalCount: 6,
    },
  };
}

function renderScreen() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ContributionHistoryScreen />
    </QueryClientProvider>,
  );
}

afterEach(cleanup);

beforeEach(() => {
  listMyContributions.mockReset();
});

describe("first page", () => {
  beforeEach(() => {
    listMyContributions.mockImplementation(async (params?: { cursor?: string }) =>
      params?.cursor === "CURSOR-1" ? page(1, null) : page(0, "CURSOR-1"),
    );
  });

  it("requests the first page with no cursor", async () => {
    renderScreen();
    await waitFor(() => expect(screen.getByTestId("contribution-row-0")).toBeTruthy());
    expect(listMyContributions).toHaveBeenCalledWith(undefined);
  });

  it("renders the lifetime total from the summary, not from the visible rows", async () => {
    renderScreen();
    await waitFor(() => expect(screen.getByTestId("contribution-lifetime-total")).toBeTruthy());
    // Rows on screen total $300; the lifetime figure is $600.
    expect(screen.getByTestId("contribution-lifetime-total").textContent).toBe("$600.00");
  });

  it("says the list is partial while more pages remain", async () => {
    renderScreen();
    await waitFor(() => expect(screen.getByTestId("contribution-showing-partial")).toBeTruthy());
    const note = screen.getByTestId("contribution-showing-partial").textContent ?? "";
    expect(note).toContain("3 most recent");
    expect(note).toContain("$300.00");
    expect(note).toContain("all 6");
    expect(screen.queryByTestId("contribution-showing-all")).toBeNull();
  });

  it("offers a Load more control", async () => {
    renderScreen();
    await waitFor(() => expect(screen.getByTestId("contribution-load-more")).toBeTruthy());
  });
});

describe("loading the next page", () => {
  beforeEach(() => {
    listMyContributions.mockImplementation(async (params?: { cursor?: string }) =>
      params?.cursor === "CURSOR-1" ? page(1, null) : page(0, "CURSOR-1"),
    );
  });

  it("passes the cursor back verbatim", async () => {
    renderScreen();
    await waitFor(() => expect(screen.getByTestId("contribution-load-more")).toBeTruthy());

    fireEvent.click(screen.getByTestId("contribution-load-more"));

    await waitFor(() => expect(listMyContributions).toHaveBeenCalledTimes(2));
    expect(listMyContributions).toHaveBeenLastCalledWith({ cursor: "CURSOR-1" });
  });

  it("appends rather than replaces", async () => {
    renderScreen();
    await waitFor(() => expect(screen.getByTestId("contribution-load-more")).toBeTruthy());

    fireEvent.click(screen.getByTestId("contribution-load-more"));

    await waitFor(() => expect(screen.getByTestId("contribution-row-5")).toBeTruthy());
    // Page one's first row is still present, in place.
    expect(screen.getByTestId("contribution-row-0").textContent).toContain("Jar 0");
    expect(screen.getByTestId("contribution-row-5").textContent).toContain("Jar 5");
  });

  it("switches to the complete message once the chain ends", async () => {
    renderScreen();
    await waitFor(() => expect(screen.getByTestId("contribution-load-more")).toBeTruthy());

    fireEvent.click(screen.getByTestId("contribution-load-more"));

    await waitFor(() => expect(screen.getByTestId("contribution-showing-all")).toBeTruthy());
    const note = screen.getByTestId("contribution-showing-all").textContent ?? "";
    // Now the rows really do add up to the headline, and the screen says so.
    expect(note).toContain("all 6");
    expect(note).toContain("$600.00");
    expect(screen.queryByTestId("contribution-showing-partial")).toBeNull();
  });

  it("removes the Load more control at the end", async () => {
    renderScreen();
    await waitFor(() => expect(screen.getByTestId("contribution-load-more")).toBeTruthy());

    fireEvent.click(screen.getByTestId("contribution-load-more"));

    await waitFor(() => expect(screen.queryByTestId("contribution-load-more")).toBeNull());
  });
});

describe("a single-page history", () => {
  beforeEach(() => {
    listMyContributions.mockResolvedValue({
      ...page(0, null),
      summary: { ...SUMMARY, contributionCount: 3, lifetimeContributedPrincipalCents: 30_000 },
    });
  });

  it("offers no Load more and reports the list as complete", async () => {
    renderScreen();
    await waitFor(() => expect(screen.getByTestId("contribution-showing-all")).toBeTruthy());
    expect(screen.queryByTestId("contribution-load-more")).toBeNull();
    expect(listMyContributions).toHaveBeenCalledTimes(1);
  });
});

describe("an empty history", () => {
  beforeEach(() => {
    listMyContributions.mockResolvedValue({
      summary: { ...SUMMARY, contributionCount: 0, lifetimeContributedPrincipalCents: 0, jarCount: 0 },
      contributions: [],
      pageInfo: { hasMore: false, nextCursor: null, limit: 50, totalCount: 0 },
    });
  });

  it("shows the empty state and no pagination control", async () => {
    renderScreen();
    await waitFor(() => expect(screen.getByText("No contributions yet")).toBeTruthy());
    expect(screen.queryByTestId("contribution-load-more")).toBeNull();
  });
});
