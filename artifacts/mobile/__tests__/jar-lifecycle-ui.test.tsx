/**
 * Phase 2: jar detail lifecycle UI tests (Members + Settings tabs).
 *
 * Renders the real app/jar/[id].tsx screen under jsdom via react-native-web
 * with all data hooks mocked.
 *
 * Covers:
 *  - non-organizers see Leave Jar (with confirmation) but no remove buttons
 *  - organizers see remove-member buttons but no Leave Jar
 *  - remove member asks for confirmation before mutating
 *  - Settings tab: organizer sees editable fields + Cancel Jar (confirmed);
 *    non-organizers get the organizer-only message
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React from "react";
import { render, fireEvent, waitFor, cleanup } from "@testing-library/react";

// ─── Mocks ───────────────────────────────────────────────────────────────────

const mockReplace = vi.fn();
vi.mock("expo-router", () => ({
  useLocalSearchParams: () => ({ id: "jar-1" }),
  useRouter: () => ({ replace: mockReplace, push: vi.fn(), back: vi.fn() }),
}));

let mockUserId = "user-organizer";
vi.mock("@/contexts/auth-context", () => ({
  useAuth: () => ({ user: { id: mockUserId } }),
}));

const baseJar = {
  id: "jar-1",
  name: "Hawaii Trip",
  description: "Aloha",
  destination: "Maui",
  status: "Active",
  organizerId: "user-organizer",
  goalAmountCents: 100000,
  currentAmountCents: 25000,
  percentComplete: 25,
  memberCount: 2,
  // A URL avoids the Metro-only `require('...jpg')` fallback branch under vitest
  coverImageUrl: "https://example.com/cover.jpg",
  targetDate: "2026-12-01",
};

const members = [
  {
    id: "m-org",
    userId: "user-organizer",
    role: "organizer",
    profile: { displayName: "Org" },
    healthStatus: "OnTrack",
    percentComplete: 50,
    contributedAmountCents: 20000,
    contributionTargetCents: 40000,
  },
  {
    id: "m-2",
    userId: "user-member",
    role: "member",
    profile: { displayName: "Mem" },
    healthStatus: "OnTrack",
    percentComplete: 10,
    contributedAmountCents: 5000,
    contributionTargetCents: 50000,
  },
];

const leaveMutate = vi.fn(async () => ({}));
const removeMutate = vi.fn(async () => ({}));
const revokeMutate = vi.fn(async () => ({}));
const updateMutate = vi.fn(async () => ({}));
const cancelMutate = vi.fn(async () => ({}));

vi.mock("@workspace/api-client-react", () => ({
  useGetJar: () => ({ data: baseJar, isLoading: false, refetch: vi.fn() }),
  useGetJarHealth: () => ({ data: undefined, refetch: vi.fn() }),
  useListJarMembers: () => ({ data: members, refetch: vi.fn() }),
  useListMilestones: () => ({ data: [], refetch: vi.fn() }),
  useListJarActivity: () => ({ data: [], refetch: vi.fn() }),
  useListAgreements: () => ({ data: [], refetch: vi.fn() }),
  useGetContributionSchedule: () => ({ data: undefined, refetch: vi.fn() }),
  useCreateInvitation: () => ({ mutateAsync: vi.fn() }),
  useListJarInvitations: () => ({
    data: [
      { id: "inv-1", email: "pending@example.com", status: "pending", sentAt: "2026-08-01", expiresAt: "2026-08-08" },
    ],
    refetch: vi.fn(),
  }),
  useRevokeInvitation: () => ({ mutateAsync: revokeMutate }),
  useLeaveJar: () => ({ mutateAsync: leaveMutate }),
  useRemoveJarMember: () => ({ mutateAsync: removeMutate }),
  useUpdateJar: () => ({ mutateAsync: updateMutate }),
  useCancelJar: () => ({ mutateAsync: cancelMutate }),
  // queryKey helpers used by the component — return stable arrays so hooks stay enabled
  getGetJarQueryKey: vi.fn((id: string) => ["jars", id]),
  getGetJarHealthQueryKey: vi.fn((id: string) => ["jars", id, "health"]),
  getListJarMembersQueryKey: vi.fn((id: string) => ["jars", id, "members"]),
  getListMilestonesQueryKey: vi.fn((id: string) => ["jars", id, "milestones"]),
  getListJarActivityQueryKey: vi.fn((id: string) => ["jars", id, "activity"]),
  getListAgreementsQueryKey: vi.fn((id: string) => ["jars", id, "agreements"]),
  getGetContributionScheduleQueryKey: vi.fn((id: string) => ["jars", id, "schedule"]),
  getListJarInvitationsQueryKey: vi.fn((id: string) => ["jars", id, "invitations"]),
}));

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
// Phase 4D hooks — return empty state so the Overview tab renders without a QueryClientProvider
vi.mock("@/hooks/useJarGoals", () => ({
  useJarGoals: () => ({ data: undefined, isLoading: false, refetch: vi.fn() }),
}));
vi.mock("@/hooks/useFinancialSummary", () => ({
  useFinancialSummary: () => ({ data: undefined, isLoading: false, refetch: vi.fn() }),
}));

import JarDetailScreen from "../app/jar/[id]";

// window.confirm drives the web confirmation path
let confirmSpy: ReturnType<typeof vi.spyOn>;
let alertSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  mockUserId = "user-organizer";
  leaveMutate.mockClear();
  removeMutate.mockClear();
  cancelMutate.mockClear();
  mockReplace.mockClear();
  confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true) as any;
  alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {}) as any;
});

afterEach(() => {
  confirmSpy.mockRestore();
  alertSpy.mockRestore();
  cleanup();
});

function openTab(utils: ReturnType<typeof render>, label: string) {
  fireEvent.click(utils.getAllByText(label)[0]!);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("Jar detail — Members tab lifecycle actions", () => {
  it("organizer sees remove buttons for other members but no Leave Jar", async () => {
    const utils = render(<JarDetailScreen />);
    openTab(utils, "Members");
    expect(await utils.findByTestId("remove-member-m-2")).toBeTruthy();
    expect(utils.queryByTestId("remove-member-m-org")).toBeNull();
    expect(utils.queryByTestId("leave-jar-button")).toBeNull();
  });

  it("remove member asks for confirmation and calls the API when confirmed", async () => {
    const utils = render(<JarDetailScreen />);
    openTab(utils, "Members");
    fireEvent.click(await utils.findByTestId("remove-member-m-2"));
    expect(confirmSpy).toHaveBeenCalled();
    await waitFor(() =>
      expect(removeMutate).toHaveBeenCalledWith({ jarId: "jar-1", memberId: "m-2" }),
    );
  });

  it("remove member does nothing when the confirmation is declined", async () => {
    confirmSpy.mockReturnValue(false);
    const utils = render(<JarDetailScreen />);
    openTab(utils, "Members");
    fireEvent.click(await utils.findByTestId("remove-member-m-2"));
    expect(removeMutate).not.toHaveBeenCalled();
  });

  it("non-organizer sees Leave Jar (confirmed) and no remove buttons", async () => {
    mockUserId = "user-member";
    const utils = render(<JarDetailScreen />);
    openTab(utils, "Members");
    expect(utils.queryByTestId("remove-member-m-org")).toBeNull();
    expect(utils.queryByTestId("remove-member-m-2")).toBeNull();
    fireEvent.click(await utils.findByTestId("leave-jar-button"));
    expect(confirmSpy).toHaveBeenCalled();
    await waitFor(() => expect(leaveMutate).toHaveBeenCalledWith({ jarId: "jar-1" }));
    await waitFor(() => expect(mockReplace).toHaveBeenCalled());
  });
});

describe("Jar detail — Settings tab", () => {
  it("organizer sees editable fields, sent invitations, and a confirmed Cancel Jar", async () => {
    const utils = render(<JarDetailScreen />);
    openTab(utils, "Settings");
    expect(await utils.findByTestId("settings-name-input")).toBeTruthy();
    expect(utils.getByTestId("settings-save-button")).toBeTruthy();
    expect(utils.getByTestId("revoke-invitation-inv-1")).toBeTruthy();

    fireEvent.click(utils.getByTestId("cancel-jar-button"));
    expect(confirmSpy).toHaveBeenCalled();
    await waitFor(() => expect(cancelMutate).toHaveBeenCalledWith({ jarId: "jar-1" }));
  });

  it("non-organizer does not see the Settings tab at all", async () => {
    mockUserId = "user-member";
    const utils = render(<JarDetailScreen />);
    expect(utils.queryByText("Settings")).toBeNull();
    expect(utils.queryByTestId("settings-name-input")).toBeNull();
    expect(utils.queryByTestId("cancel-jar-button")).toBeNull();
  });
});
