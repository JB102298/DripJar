/**
 * Milestones tab — per-milestone suppression when the split does not reconcile
 * (Owner QA item 3, screen half)
 *
 * milestone-reconciliation-ui.test.tsx proves the summary card behaves. This
 * proves the milestone LIST obeys the same gate, which is the half that is easy
 * to forget: the API zeroes every `allocatedAmountCents` when `reconciles` is
 * false, so a list that keeps rendering them states "$0 of $2,000 — 0% funded"
 * for a jar holding $7,274. That is not a softer version of the bug, it is a
 * new wrong answer with a confident progress bar attached.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import React from "react";
import { render, cleanup, fireEvent, screen } from "@testing-library/react";

const { milestoneSummary } = vi.hoisted(() => ({
  milestoneSummary: {
    current: undefined as
      | { savedPrincipalCents: number; totalAllocatedCents: number; unallocatedCents: number; reconciles: boolean }
      | undefined,
  },
}));

const milestones = [
  {
    id: "ms-1",
    jarId: "jar-1",
    name: "Flights",
    description: null,
    targetAmountCents: 200_000,
    allocatedAmountCents: 0, // what the API returns while reconciles === false
    percentFunded: 0,
    dueDate: null,
    priority: 0,
    status: "pending",
    createdAt: "2026-01-01T00:00:00Z",
  },
];

vi.mock("expo-router", () => ({
  useLocalSearchParams: () => ({ id: "jar-1" }),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), back: vi.fn() }),
}));

vi.mock("@/contexts/auth-context", () => ({
  useAuth: () => ({ user: { id: "user-1" } }),
}));

vi.mock("@workspace/api-client-react", () => ({
  useGetJar: () => ({
    data: {
      id: "jar-1",
      name: "Hawaii 2027",
      organizerId: "user-1",
      status: "Saving",
      goalAmountCents: 1_000_000,
      totalSavedCents: 727_400,
      percentFunded: 72.7,
      memberCount: 3,
      targetDate: "2027-06-01",
      coverImageUrl: "https://example.com/cover.jpg",
    },
    isLoading: false,
    refetch: vi.fn(),
  }),
  useGetJarHealth: () => ({ data: undefined, refetch: vi.fn() }),
  useListJarMembers: () => ({ data: [], refetch: vi.fn() }),
  useListMilestones: () => ({ data: milestones, refetch: vi.fn() }),
  useListJarActivity: () => ({ data: [], refetch: vi.fn() }),
  useListAgreements: () => ({ data: [], refetch: vi.fn() }),
  useGetContributionSchedule: () => ({ data: undefined, refetch: vi.fn() }),
  useListJarInvitations: () => ({ data: [], refetch: vi.fn() }),
  useCreateInvitation: () => ({ mutateAsync: vi.fn() }),
  useRevokeInvitation: () => ({ mutateAsync: vi.fn() }),
  useLeaveJar: () => ({ mutateAsync: vi.fn() }),
  useRemoveJarMember: () => ({ mutateAsync: vi.fn() }),
  useUpdateJar: () => ({ mutateAsync: vi.fn() }),
  useCancelJar: () => ({ mutateAsync: vi.fn() }),
  getGetJarQueryKey: (id: string) => ["jars", id],
  getGetJarHealthQueryKey: (id: string) => ["jars", id, "health"],
  getListJarMembersQueryKey: (id: string) => ["jars", id, "members"],
  getListMilestonesQueryKey: (id: string) => ["jars", id, "milestones"],
  getListJarActivityQueryKey: (id: string) => ["jars", id, "activity"],
  getListAgreementsQueryKey: (id: string) => ["jars", id, "agreements"],
  getGetContributionScheduleQueryKey: (id: string) => ["jars", id, "schedule"],
  getListJarInvitationsQueryKey: (id: string) => ["jars", id, "invitations"],
}));

vi.mock("@/hooks/useJarGoals", () => ({
  useJarGoals: () => ({ data: undefined, isLoading: false, refetch: vi.fn() }),
}));
vi.mock("@/hooks/useFinancialSummary", () => ({
  useFinancialSummary: () => ({ data: undefined, isLoading: false, refetch: vi.fn() }),
}));
// The gate itself is deliberately NOT mocked — it is the thing under test.
// No generic on importActual: this is a .tsx file, where `<typeof ...>` parses
// as JSX and fails at runtime.
vi.mock("@/hooks/useMilestoneSummary", async () => {
  const actual = await vi.importActual("../hooks/useMilestoneSummary");
  return {
    ...actual,
    useMilestoneSummary: () => ({ data: milestoneSummary.current, isLoading: false, refetch: vi.fn() }),
  };
});

vi.mock("@/hooks/useColors", () => ({
  useColors: () => new Proxy({}, { get: () => "#000000" }),
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock("@expo/vector-icons", () => ({ Feather: () => null }));
vi.mock("expo-image", () => ({ ImageBackground: ({ children }: any) => <>{children}</> }));
vi.mock("expo-linear-gradient", () => ({ LinearGradient: ({ children }: any) => <>{children}</> }));
vi.mock("@/components/SkeletonLoader", () => ({ SkeletonLoader: () => null }));
vi.mock("@/components/CircularProgress", () => ({ CircularProgress: () => null }));
vi.mock("@/components/JarHealthBadge", () => ({ JarHealthBadge: () => null }));
vi.mock("@/components/MemberAvatar", () => ({ MemberAvatar: () => null }));
vi.mock("@/components/ScheduleSetupSheet", () => ({ ScheduleSetupSheet: () => null }));
// Plain host elements, not `require("react-native")`: a bare require bypasses
// the vitest `react-native` → `react-native-web` alias and loads React Native's
// Flow-typed source, which is not valid JavaScript.
vi.mock("@/components/EmptyState", () => ({
  EmptyState: ({ title }: any) => <div data-testid="empty-state">{title}</div>,
}));
// Rendered as a marker so "is there a funding progress bar" is directly assertable.
vi.mock("@/components/ProgressBar", () => ({
  ProgressBar: () => <div data-testid="milestone-progress-bar" />,
}));

import JarDetailScreen from "../app/jar/[id]";

afterEach(cleanup);

function openMilestones() {
  render(<JarDetailScreen />);
  fireEvent.click(screen.getAllByText("Milestones")[0]!);
}

describe("Milestones tab when the split does not reconcile", () => {
  it("shows the target but not a funded amount", () => {
    milestoneSummary.current = {
      savedPrincipalCents: 727_400,
      totalAllocatedCents: 0,
      unallocatedCents: 727_400,
      reconciles: false,
    };
    openMilestones();

    expect(screen.getByText("Target $2,000")).toBeTruthy();
    // "$0 of $2,000" is the misleading string this suppression exists to stop.
    expect(screen.queryByText(/\$0 of \$2,000/)).toBeNull();
  });

  it("hides the per-milestone progress bar", () => {
    milestoneSummary.current = {
      savedPrincipalCents: 727_400,
      totalAllocatedCents: 0,
      unallocatedCents: 727_400,
      reconciles: false,
    };
    openMilestones();
    expect(screen.queryByTestId("milestone-progress-bar")).toBeNull();
  });

  it("shows the safe explanatory state instead of the breakdown", () => {
    milestoneSummary.current = {
      savedPrincipalCents: 727_400,
      totalAllocatedCents: 0,
      unallocatedCents: 727_400,
      reconciles: false,
    };
    openMilestones();
    expect(screen.getByTestId("milestone-summary-unreconciled")).toBeTruthy();
    expect(screen.queryByTestId("milestone-summary-reconciled")).toBeNull();
  });
});

describe("Milestones tab when the split reconciles", () => {
  it("shows funded amounts and the progress bar again", () => {
    milestoneSummary.current = {
      savedPrincipalCents: 727_400,
      totalAllocatedCents: 150_000,
      unallocatedCents: 577_400,
      reconciles: true,
    };
    // The milestone rows carry real allocations in this state.
    milestones[0]!.allocatedAmountCents = 150_000;
    milestones[0]!.percentFunded = 75;

    openMilestones();

    expect(screen.getByText("$1,500 of $2,000")).toBeTruthy();
    expect(screen.getByTestId("milestone-progress-bar")).toBeTruthy();
    expect(screen.getByTestId("milestone-summary-reconciled")).toBeTruthy();
  });
});

describe("Milestones tab while the summary has not loaded", () => {
  it("withholds funding figures rather than assuming they are sound", () => {
    // A slow or failing summary endpoint must not silently re-enable the
    // display it exists to gate.
    milestoneSummary.current = undefined;
    milestones[0]!.allocatedAmountCents = 150_000;
    milestones[0]!.percentFunded = 75;

    openMilestones();

    expect(screen.queryByText("$1,500 of $2,000")).toBeNull();
    expect(screen.getByText("Target $2,000")).toBeTruthy();
    expect(screen.queryByTestId("milestone-progress-bar")).toBeNull();
  });
});
