/**
 * The jar surface a notification tap lands on.
 *
 * notification-presentation.test.ts proves which href each type produces. This
 * proves the jar screen honours the `tab` those hrefs carry — a milestone
 * notification is supposed to land on Milestones, not on Overview — and that
 * the two ways it can go wrong do not:
 *
 *   - a `tab` naming the organizer-only Settings tab must not select it
 *   - a jar the caller can no longer reach must render one neutral message,
 *     the same one whether the API said 403 or 404
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { render, cleanup, screen } from "@testing-library/react";

const { params, jarState, viewerState } = vi.hoisted(() => ({
  params: { current: { id: "jar-1" } as { id: string; tab?: string } },
  jarState: { data: undefined as unknown, isLoading: false },
  viewerState: { userId: "user-1", organizerId: "user-1" },
}));

const JAR = {
  id: "jar-1",
  name: "Trip Fund",
  organizerId: "user-1",
  status: "Saving",
  category: "Vacation",
  goalAmountCents: 1_000_000,
  totalSavedCents: 250_000,
  percentFunded: 25,
  memberCount: 3,
  targetDate: "2027-06-01",
  coverImageUrl: "https://example.com/cover.jpg",
};

const MILESTONES = [
  {
    id: "ms-1",
    jarId: "jar-1",
    name: "MILESTONE-MARKER",
    description: null,
    targetAmountCents: 200_000,
    allocatedAmountCents: 0,
    percentFunded: 0,
    dueDate: null,
    priority: 0,
    status: "pending",
    createdAt: "2026-01-01T00:00:00Z",
  },
];

const MEMBERS = [
  {
    id: "m-1",
    jarId: "jar-1",
    userId: "user-2",
    role: "member",
    status: "active",
    healthStatus: "on_track",
    contributedCents: 50_000,
    contributionTargetCents: 200_000,
    percentComplete: 25,
    profile: { userId: "user-2", displayName: "MEMBER-MARKER", avatarUrl: null },
  },
];

const ACTIVITY = [
  {
    id: "a-1",
    jarId: "jar-1",
    userId: "user-2",
    eventType: "member_joined",
    description: "ACTIVITY-MARKER",
    actorName: "Someone",
    actorAvatarUrl: null,
    amountCents: null,
    metadata: null,
    createdAt: "2026-01-01T00:00:00Z",
  },
];

const AGREEMENTS = [
  { id: "ag-1", jarId: "jar-1", version: "2.0", content: "AGREEMENT-MARKER", myAcceptance: null },
];

vi.mock("expo-router", () => ({
  useLocalSearchParams: () => params.current,
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), back: vi.fn() }),
}));

vi.mock("@/contexts/auth-context", () => ({
  useAuth: () => ({ user: { id: viewerState.userId } }),
}));

vi.mock("@workspace/api-client-react", () => ({
  JarStatus: {
    Draft: "Draft",
    Inviting: "Inviting",
    Saving: "Saving",
    CommitmentPending: "CommitmentPending",
    Committed: "Committed",
    FullyFunded: "FullyFunded",
    Completed: "Completed",
    Cancelled: "Cancelled",
  },
  useGetJar: () => ({ ...jarState, refetch: vi.fn() }),
  useGetJarHealth: () => ({ data: undefined, refetch: vi.fn() }),
  useListJarMembers: () => ({ data: MEMBERS, refetch: vi.fn() }),
  useListMilestones: () => ({ data: MILESTONES, refetch: vi.fn() }),
  useListJarActivity: () => ({ data: ACTIVITY, refetch: vi.fn() }),
  useListAgreements: () => ({ data: AGREEMENTS, refetch: vi.fn() }),
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
vi.mock("@/hooks/useMilestoneSummary", async () => {
  const actual = await vi.importActual("../hooks/useMilestoneSummary");
  return { ...actual, useMilestoneSummary: () => ({ data: undefined, isLoading: false, refetch: vi.fn() }) };
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
vi.mock("@/components/ProgressBar", () => ({ ProgressBar: () => null }));
vi.mock("@/components/ScheduleSetupSheet", () => ({ ScheduleSetupSheet: () => null }));
vi.mock("@/components/MilestoneAllocationSummary", () => ({ MilestoneAllocationSummary: () => null }));
vi.mock("@/components/MemberAvatar", () => ({
  MemberAvatar: ({ displayName }: any) => <div>{displayName}</div>,
}));
vi.mock("@/components/EmptyState", () => ({
  EmptyState: ({ title, description }: any) => (
    <div data-testid="empty-state">{[title, description].filter(Boolean).join(" — ")}</div>
  ),
}));

import JarDetailScreen from "../app/jar/[id]";

const open = (tab?: string) => {
  params.current = tab === undefined ? { id: "jar-1" } : { id: "jar-1", tab };
  return render(<JarDetailScreen />);
};

beforeEach(() => {
  vi.clearAllMocks();
  jarState.data = JAR;
  jarState.isLoading = false;
  viewerState.userId = "user-1";
});

afterEach(cleanup);

describe("tab deep links from a notification", () => {
  it("opens Milestones for a milestone notification", () => {
    open("Milestones");
    expect(screen.getByText("MILESTONE-MARKER")).toBeTruthy();
  });

  it("opens Members for a member notification", () => {
    open("Members");
    // The name appears both on the avatar and in the row, so this asserts
    // presence rather than uniqueness.
    expect(screen.getAllByText("MEMBER-MARKER").length).toBeGreaterThan(0);
  });

  it("opens Activity for a contribution notification", () => {
    open("Activity");
    expect(screen.getByText("ACTIVITY-MARKER")).toBeTruthy();
  });

  it("opens Agreements for an agreement notification", () => {
    open("Agreements");
    expect(screen.getByText("AGREEMENT-MARKER")).toBeTruthy();
  });

  it("stays on Overview when no tab is given", () => {
    open();
    expect(screen.queryByText("MILESTONE-MARKER")).toBeNull();
    expect(screen.queryByText("AGREEMENT-MARKER")).toBeNull();
  });

  it("ignores an unrecognised tab rather than rendering nothing", () => {
    open("NotATab");
    expect(screen.queryByText("MILESTONE-MARKER")).toBeNull();
    expect(screen.queryByText("AGREEMENT-MARKER")).toBeNull();
    // Overview rendered, so the screen is usable rather than blank.
    expect(screen.getByText("Trip Fund")).toBeTruthy();
  });

  it("ignores a tab name that differs only in case", () => {
    open("milestones");
    expect(screen.queryByText("MILESTONE-MARKER")).toBeNull();
  });
});

describe("the organizer-only tab is not deep-linkable", () => {
  it("does not select Settings for the organizer", () => {
    open("Settings");
    // Settings is not selected at all, so its organizer controls never mount.
    expect(screen.queryByTestId("cancel-jar-button")).toBeNull();
  });

  it("does not select Settings for a member", () => {
    viewerState.userId = "user-2"; // not the organizer
    open("Settings");
    // The screen's own organizer guard would also catch this; excluding
    // Settings from the linkable set means the guard is never the only thing
    // standing between a member and the organizer pane.
    expect(screen.queryByText(/Organizer only/)).toBeNull();
    expect(screen.queryByTestId("leave-jar-button-settings")).toBeNull();
  });
});

describe("a jar the caller cannot reach", () => {
  it("shows one neutral message", () => {
    jarState.data = undefined;
    open("Milestones");

    expect(screen.getByTestId("empty-state").textContent).toBe("Jar not found");
  });

  it("says the same thing whether access was lost or the jar never existed", () => {
    // The screen consumes only `data`, so a 403 and a 404 are indistinguishable
    // on screen — which is the point: the message must not reveal that the jar
    // exists for somebody else.
    jarState.data = undefined;
    const forbidden = render(<JarDetailScreen />).container.textContent;
    cleanup();

    jarState.data = undefined;
    const missing = render(<JarDetailScreen />).container.textContent;

    expect(forbidden).toBe(missing);
    expect(forbidden).not.toMatch(/permission|access|forbidden|member/i);
  });

  it("does not leak the jar id", () => {
    jarState.data = undefined;
    const { container } = open();
    expect(container.textContent).not.toContain("jar-1");
  });
});
