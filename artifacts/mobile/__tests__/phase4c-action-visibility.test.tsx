/**
 * Phase 4C — Commit / Refund action button visibility tests
 *
 * Verifies that the Overview tab of the jar detail screen shows/hides the
 * "Lock In" (commit) and "Refund" buttons according to Phase 4C business rules:
 *
 *   Refund button   — visible whenever the jar is in Saving or Commitment phase
 *                     (NO cutoff-date requirement; the API has no cutoff gate)
 *   Lock In button  — visible only once the commitment cutoff has been reached
 *                     (phase = 'Commitment')
 *
 * API-side enforcement lives in phase4c-commitment.test.ts and
 * phase4c-refunds.test.ts. These tests cover the mobile-layer visibility rules.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React from "react";
import { render, cleanup } from "@testing-library/react";

// ─── Expo-router ─────────────────────────────────────────────────────────────
vi.mock("expo-router", () => ({
  useLocalSearchParams: () => ({ id: "jar-1" }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}));

// ─── Auth context ─────────────────────────────────────────────────────────────
vi.mock("@/contexts/auth-context", () => ({
  useAuth: () => ({ user: { id: "user-1" } }),
}));

// ─── Jar data stubs ──────────────────────────────────────────────────────────
// Base jar fields shared by all variants
const baseJar = {
  id: "jar-1",
  name: "Savings Jar",
  organizerId: "user-1",
  goalAmountCents: 100_000,
  totalSavedCents: 25_000,
  percentFunded: 25,
  daysRemaining: 60,
  description: null,
  destination: null,
  coverImageUrl: "https://example.com/cover.jpg",
};

// Saving phase — cutoff date is in the future, no commitment possible yet
const savingJar = {
  ...baseJar,
  status: "Saving",
  phase: "Saving",
  cutoffDate: "2099-12-31",   // future
  daysUntilCutoff: 365,
};

// Commitment phase — cutoff date has passed
const commitmentJar = {
  ...baseJar,
  status: "Saving",           // DB status stays "Saving"; phase is derived
  phase: "Commitment",
  cutoffDate: "2020-01-01",   // past
  daysUntilCutoff: -365,
};

// Inactive jar (cancelled) — neither button should appear
const cancelledJar = {
  ...baseJar,
  status: "Cancelled",
  phase: "Cancelled",
  cutoffDate: null,
  daysUntilCutoff: null,
};

// Mutable reference — vi.mock factory captures this by reference
let mockJarData: typeof savingJar | typeof commitmentJar | typeof cancelledJar = savingJar;

// ─── API client mock ─────────────────────────────────────────────────────────
vi.mock("@workspace/api-client-react", () => ({
  useGetJar: () => ({ data: mockJarData, isLoading: false, refetch: vi.fn() }),
  useGetJarHealth: () => ({ data: undefined, refetch: vi.fn() }),
  useListJarMembers: () => ({ data: [], refetch: vi.fn() }),
  useListMilestones: () => ({ data: [], refetch: vi.fn() }),
  useListJarActivity: () => ({ data: [], refetch: vi.fn() }),
  useListAgreements: () => ({ data: [], refetch: vi.fn() }),
  useGetContributionSchedule: () => ({ data: undefined, refetch: vi.fn() }),
  useCreateInvitation: () => ({ mutateAsync: vi.fn() }),
  useListJarInvitations: () => ({ data: [], refetch: vi.fn() }),
  useRevokeInvitation: () => ({ mutateAsync: vi.fn() }),
  useLeaveJar: () => ({ mutateAsync: vi.fn() }),
  useRemoveJarMember: () => ({ mutateAsync: vi.fn() }),
  useUpdateJar: () => ({ mutateAsync: vi.fn() }),
  useCancelJar: () => ({ mutateAsync: vi.fn() }),
  // Query key helpers
  getGetJarQueryKey: vi.fn((id: string) => ["jars", id]),
  getGetJarHealthQueryKey: vi.fn((id: string) => ["jars", id, "health"]),
  getListJarMembersQueryKey: vi.fn((id: string) => ["jars", id, "members"]),
  getListMilestonesQueryKey: vi.fn((id: string) => ["jars", id, "milestones"]),
  getListJarActivityQueryKey: vi.fn((id: string) => ["jars", id, "activity"]),
  getListAgreementsQueryKey: vi.fn((id: string) => ["jars", id, "agreements"]),
  getGetContributionScheduleQueryKey: vi.fn((id: string) => ["jars", id, "schedule"]),
  getListJarInvitationsQueryKey: vi.fn((id: string) => ["jars", id, "invitations"]),
}));

// ─── Component dependencies ───────────────────────────────────────────────────
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
vi.mock("@/components/ProgressBar", () => ({ ProgressBar: () => null }));
vi.mock("@/components/MemberAvatar", () => ({ MemberAvatar: () => null }));
vi.mock("@/components/EmptyState", () => ({
  EmptyState: ({ title }: any) => {
    const { Text } = require("react-native");
    return <Text testID="empty-state">{title}</Text>;
  },
}));
vi.mock("@/components/ScheduleSetupSheet", () => ({ ScheduleSetupSheet: () => null }));

// Static import must come after all vi.mock calls
import JarDetailScreen from "../app/jar/[id]";

afterEach(() => cleanup());

// ─────────────────────────────────────────────────────────────────────────────
// Before commitment cutoff (Saving phase)
// ─────────────────────────────────────────────────────────────────────────────

describe("Phase 4C action buttons — Saving phase (before cutoff)", () => {
  beforeEach(() => {
    mockJarData = savingJar;
  });

  it("shows the Refund button", () => {
    const { queryByTestId } = render(<JarDetailScreen />);
    expect(queryByTestId("refund-button")).not.toBeNull();
  });

  it("hides the Lock In (commit) button — cutoff not yet reached", () => {
    const { queryByTestId } = render(<JarDetailScreen />);
    expect(queryByTestId("commit-button")).toBeNull();
  });

  it("shows Refund without requiring the cutoff to have passed", () => {
    // Explicitly set a future cutoff; Refund must still appear
    mockJarData = { ...savingJar, cutoffDate: "2099-01-01" };
    const { queryByTestId } = render(<JarDetailScreen />);
    expect(queryByTestId("refund-button")).not.toBeNull();
    expect(queryByTestId("commit-button")).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// After commitment cutoff (Commitment phase)
// ─────────────────────────────────────────────────────────────────────────────

describe("Phase 4C action buttons — Commitment phase (after cutoff)", () => {
  beforeEach(() => {
    mockJarData = commitmentJar;
  });

  it("shows the Refund button", () => {
    const { queryByTestId } = render(<JarDetailScreen />);
    expect(queryByTestId("refund-button")).not.toBeNull();
  });

  it("shows the Lock In (commit) button — cutoff has passed", () => {
    const { queryByTestId } = render(<JarDetailScreen />);
    expect(queryByTestId("commit-button")).not.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Inactive jar (cancelled / completed)
// ─────────────────────────────────────────────────────────────────────────────

describe("Phase 4C action buttons — Cancelled jar", () => {
  beforeEach(() => {
    mockJarData = cancelledJar;
  });

  it("hides the Refund button when jar is cancelled", () => {
    const { queryByTestId } = render(<JarDetailScreen />);
    expect(queryByTestId("refund-button")).toBeNull();
  });

  it("hides the Lock In button when jar is cancelled", () => {
    const { queryByTestId } = render(<JarDetailScreen />);
    expect(queryByTestId("commit-button")).toBeNull();
  });
});
