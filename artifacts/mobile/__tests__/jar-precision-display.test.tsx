/**
 * Stored precision is honoured on every surface that shows a jar's target date.
 *
 * Persisting the precision (remediation item 1) is only half the fix. If the
 * screens keep rendering `daysRemaining` or a full date regardless, a
 * year-precision college fund still reads as "January 1, 2044" or as a day
 * count that ticks down nightly — which is arguably worse than the original
 * bug, because the false precision now looks actively maintained.
 *
 * `date-precision.test.ts` proves the formatting functions. This proves the
 * components call them, which is where the equivalent mistake would live.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import React from "react";
import { render, cleanup, screen } from "@testing-library/react";

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
vi.mock("expo-image", () => ({
  ImageBackground: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  Image: () => null,
}));
vi.mock("expo-linear-gradient", () => ({ LinearGradient: () => null }));
vi.mock("@/components/ProgressBar", () => ({ ProgressBar: () => null }));
vi.mock("@/components/JarHealthBadge", () => ({ JarHealthBadge: () => null }));

const { myJarsData } = vi.hoisted(() => ({
  myJarsData: {
    value: {
      summary: {
        lifetimeContributedPrincipalCents: 0,
        currentlySavedPrincipalCents: 0,
        refundedPrincipalCents: 0,
        jarCount: 0,
        contributionCount: 0,
        reconciles: true,
      },
      jars: [] as Array<Record<string, unknown>>,
    },
  },
}));

vi.mock("@workspace/api-client-react", () => ({
  useListMyJars: () => ({ data: myJarsData.value, isLoading: false, isError: false }),
}));

import { JarCard } from "../components/JarCard";
import JarHistoryScreen from "../app/history/jars";

afterEach(cleanup);

/**
 * `coverImageUrl` is deliberately set on every fixture.
 *
 * JarCard falls back to `require('../assets/images/hawaii-cover.jpg')` when it
 * is null. Metro resolves that to a numeric asset handle; Vitest has no such
 * loader and tries to parse the JPEG as a module. Supplying a URL takes the
 * branch that never touches the binary — the countdown logic under test is
 * unaffected either way.
 */
const baseJar = {
  id: "jar-1",
  organizerId: "u1",
  name: "Ava's College Fund",
  category: "Education",
  destination: null,
  coverImageUrl: "https://example.invalid/cover.jpg",
  cutoffDate: null,
  goalAmountCents: 12_000_000,
  currency: "USD",
  status: "Saving",
  phase: "Saving",
  memberCount: 1,
  totalSavedCents: 0,
  percentFunded: 0,
  userRole: "organizer",
  health: null,
} as const;

describe("JarCard — countdown phrased at the stored precision", () => {
  it("counts days for an exact target", () => {
    render(
      <JarCard
        jar={{ ...baseJar, targetDate: "2027-06-14", targetDatePrecision: "exact", daysRemaining: 300 } as any}
      />,
    );
    expect(screen.getByTestId("jar-card-time-remaining").textContent).toBe("300 days left");
  });

  it("names the year for a year-precision target and shows no day count", () => {
    render(
      <JarCard
        jar={{ ...baseJar, targetDate: "2044-01-01", targetDatePrecision: "year", daysRemaining: 6570 } as any}
      />,
    );
    const label = screen.getByTestId("jar-card-time-remaining").textContent ?? "";
    expect(label).toBe("by 2044");
    expect(label).not.toMatch(/day/);
    expect(label).not.toMatch(/January/);
  });

  it("names the month for a monthYear target", () => {
    render(
      <JarCard
        jar={{ ...baseJar, targetDate: "2028-09-01", targetDatePrecision: "monthYear", daysRemaining: 800 } as any}
      />,
    );
    expect(screen.getByTestId("jar-card-time-remaining").textContent).toBe("by September 2028");
  });

  it("falls back to a day count when the server omits the field", () => {
    // An older server, or a cached response from before the column existed.
    render(
      <JarCard jar={{ ...baseJar, targetDate: "2027-06-14", daysRemaining: 300 } as any} />,
    );
    expect(screen.getByTestId("jar-card-time-remaining").textContent).toBe("300 days left");
  });

  it("renders no chip at all rather than an empty one", () => {
    render(
      <JarCard
        jar={{ ...baseJar, targetDate: "2027-06-14", targetDatePrecision: "exact", daysRemaining: null } as any}
      />,
    );
    expect(screen.queryByTestId("jar-card-time-remaining")).toBeNull();
  });
});

describe("Jar History — each jar's own precision, not a fixed one", () => {
  function renderWithJars(jars: Array<Record<string, unknown>>) {
    myJarsData.value = {
      summary: {
        lifetimeContributedPrincipalCents: 0,
        currentlySavedPrincipalCents: 0,
        refundedPrincipalCents: 0,
        jarCount: jars.length,
        contributionCount: 0,
        reconciles: true,
      },
      jars,
    };
    render(<JarHistoryScreen />);
  }

  const historyJar = (over: Record<string, unknown>) => ({
    jarId: "j1",
    name: "Jar",
    category: "Education",
    status: "Saving",
    role: "organizer",
    membershipStatus: "active",
    joinedAt: null,
    goalAmountCents: 100,
    currency: "USD",
    lifetimeContributedPrincipalCents: 0,
    currentlySavedPrincipalCents: 0,
    refundedPrincipalCents: 0,
    contributionCount: 0,
    reconciles: true,
    ...over,
  });

  it("shows a bare year for a year-precision jar", () => {
    renderWithJars([historyJar({ targetDate: "2044-01-01", targetDatePrecision: "year" })]);
    const meta = screen.getByTestId("jar-history-meta-j1").textContent ?? "";
    expect(meta).toContain("2044");
    expect(meta).not.toContain("January");
  });

  it("shows month and year for a monthYear jar", () => {
    renderWithJars([historyJar({ targetDate: "2028-09-01", targetDatePrecision: "monthYear" })]);
    expect(screen.getByTestId("jar-history-meta-j1").textContent).toContain("September 2028");
  });

  it("shows the full date for an exact jar", () => {
    renderWithJars([historyJar({ targetDate: "2027-06-14", targetDatePrecision: "exact" })]);
    expect(screen.getByTestId("jar-history-meta-j1").textContent).toContain("June 14, 2027");
  });

  it("renders jars of different precisions correctly in one list", () => {
    // The old implementation hard-coded 'monthYear' for every row, so this is
    // the case that would have regressed silently.
    renderWithJars([
      historyJar({ jarId: "j1", targetDate: "2044-01-01", targetDatePrecision: "year" }),
      historyJar({ jarId: "j2", targetDate: "2027-06-14", targetDatePrecision: "exact" }),
    ]);
    expect(screen.getByTestId("jar-history-meta-j1").textContent).toContain("2044");
    expect(screen.getByTestId("jar-history-meta-j1").textContent).not.toContain("January");
    expect(screen.getByTestId("jar-history-meta-j2").textContent).toContain("June 14, 2027");
  });
});
