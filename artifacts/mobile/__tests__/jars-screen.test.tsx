/**
 * My Jars screen — Owner QA item 10
 *
 * jar-tab-status.test.ts proves the mapping. This proves the screen uses it,
 * which is where the bug lived: the mapping module could be perfect and Active
 * would still be empty if the screen kept sending its own hardcoded
 * `"Saving,FullyFunded"`.
 *
 * Guards specifically against:
 *   - the hardcoded "Saving,FullyFunded" filter reappearing
 *   - Draft dropping out of the Active request
 *   - the Invited tab going back to filtering jar lifecycle status
 *   - a failed request rendering as "you have no jars"
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { render, cleanup, fireEvent, screen } from "@testing-library/react";

// ─── Query state, controllable per test ──────────────────────────────────────

const { listJarsCalls, jarsState, invitationsState } = vi.hoisted(() => ({
  listJarsCalls: [] as ({ status?: string } | undefined)[],
  jarsState: {
    data: undefined as unknown[] | undefined,
    isLoading: false,
    isError: false,
    isRefetching: false,
  },
  invitationsState: {
    data: undefined as unknown[] | undefined,
    isLoading: false,
    isError: false,
    isRefetching: false,
  },
}));

vi.mock("@workspace/api-client-react", () => ({
  // The real generated enum — lib/jar-status.ts builds its status lists from it,
  // so stubbing it would let the mapping drift from the spec unnoticed.
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
  useListJars: (params?: { status?: string }) => {
    listJarsCalls.push(params);
    return { ...jarsState, refetch: vi.fn() };
  },
  useListMyInvitations: () => ({ ...invitationsState, refetch: vi.fn() }),
  getListJarsQueryKey: (params?: unknown) => ["/api/jars", params],
  getListMyInvitationsQueryKey: () => ["/api/invitations"],
}));

const mockPush = vi.fn();
vi.mock("expo-router", () => ({
  useRouter: () => ({ push: mockPush, replace: vi.fn(), back: vi.fn() }),
}));

vi.mock("@/hooks/useColors", () => ({
  useColors: () => ({
    background: "#fff", foreground: "#000", card: "#fff", primary: "#178B57",
    primaryForeground: "#fff", secondary: "#E8F6EF", secondaryForeground: "#0E5F3B",
    muted: "#eee", mutedForeground: "#657069", border: "#ddd", destructive: "#C94B4B",
    destructiveForeground: "#fff", success: "#2E9D63", warning: "#D99A25",
    darkGreen: "#0E5F3B", lightGreen: "#E8F6EF", radius: 12,
  }),
}));

vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock("@expo/vector-icons", () => ({ Feather: () => null }));
vi.mock("@/components/SkeletonLoader", () => ({ SkeletonLoader: () => null }));

// Render jar/invitation identity as plain text so assertions do not depend on
// the cards' internal layout.
vi.mock("@/components/JarCard", () => ({
  JarCard: ({ jar }: { jar: { name: string; status: string } }) => (
    <div data-testid="jar-card">{`${jar.name} [${jar.status}]`}</div>
  ),
}));
vi.mock("@/components/InvitationCard", () => ({
  InvitationCard: ({ invitation }: { invitation: { jar: { name: string } } }) => (
    <div data-testid="invitation-card">{`invite: ${invitation.jar.name}`}</div>
  ),
}));

import JarsScreen from "../app/(tabs)/jars";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const jar = (name: string, status: string) => ({
  id: `jar-${name}`,
  name,
  status,
  goalAmountCents: 500_000,
  totalSavedCents: 0,
  percentFunded: 0,
  memberCount: 1,
  daysRemaining: 90,
  coverImageUrl: "https://example.com/cover.jpg",
});

const invitation = (jarName: string, status: string, expiresAt: string) => ({
  id: `inv-${jarName}`,
  status,
  expiresAt,
  token: "tok-123",
  jar: jar(jarName, "Inviting"),
});

beforeEach(() => {
  listJarsCalls.length = 0;
  mockPush.mockClear();
  Object.assign(jarsState, { data: undefined, isLoading: false, isError: false, isRefetching: false });
  Object.assign(invitationsState, { data: undefined, isLoading: false, isError: false, isRefetching: false });
});

afterEach(cleanup);

/** The `status` value most recently sent to GET /jars. */
const lastStatusParam = () => listJarsCalls[listJarsCalls.length - 1]?.status;

// ─── Active tab ──────────────────────────────────────────────────────────────

describe("Active tab request", () => {
  it("asks for every live status, including Draft", () => {
    jarsState.data = [];
    render(<JarsScreen />);

    const status = lastStatusParam();
    expect(status).toBeDefined();
    const requested = status!.split(",");
    expect(requested).toContain("Draft");
    expect(requested).toContain("Saving");
    expect(requested).toContain("FullyFunded");
    expect(requested).toContain("Inviting");
  });

  it("never sends the old hardcoded filter", () => {
    jarsState.data = [];
    render(<JarsScreen />);
    // The exact string that made Active empty for every user.
    expect(lastStatusParam()).not.toBe("Saving,FullyFunded");
  });

  it("does not request terminal statuses", () => {
    jarsState.data = [];
    render(<JarsScreen />);
    const requested = lastStatusParam()!.split(",");
    expect(requested).not.toContain("Completed");
    expect(requested).not.toContain("Cancelled");
  });

  it("renders a Draft jar the API returns", () => {
    // The reported symptom: a jar created moments ago, nowhere to be seen.
    jarsState.data = [jar("Down payment for a house", "Draft")];
    render(<JarsScreen />);
    expect(screen.getByText("Down payment for a house [Draft]")).toBeTruthy();
  });

  it("offers Create a Jar when the user genuinely has none", () => {
    jarsState.data = [];
    render(<JarsScreen />);
    fireEvent.click(screen.getByText("Create a Jar"));
    expect(mockPush).toHaveBeenCalledWith("/create-jar");
  });
});

// ─── Terminal tabs ───────────────────────────────────────────────────────────

describe("Completed and Archived tabs", () => {
  it.each([
    ["Completed", "Completed"],
    ["Archived", "Cancelled"],
  ])("%s requests status=%s", (tab, expected) => {
    jarsState.data = [];
    render(<JarsScreen />);
    fireEvent.click(screen.getByText(tab));
    expect(lastStatusParam()).toBe(expected);
  });
});

// ─── Invited tab ─────────────────────────────────────────────────────────────

describe("Invited tab", () => {
  it("does not filter jar lifecycle status", () => {
    invitationsState.data = [];
    render(<JarsScreen />);
    fireEvent.click(screen.getByText("Invited"));
    // Previously this tab sent status=Inviting, which returned jars the user
    // organizes — never jars they were invited to.
    expect(lastStatusParam()).toBeUndefined();
  });

  it("renders only actionable invitations", () => {
    invitationsState.data = [
      invitation("Beach House", "pending", "2099-01-01T00:00:00Z"),
      invitation("Already Joined", "accepted", "2099-01-01T00:00:00Z"),
      invitation("Lapsed", "pending", "2000-01-01T00:00:00Z"),
    ];
    render(<JarsScreen />);
    fireEvent.click(screen.getByText("Invited"));

    expect(screen.getByText("invite: Beach House")).toBeTruthy();
    expect(screen.queryByText("invite: Already Joined")).toBeNull();
    expect(screen.queryByText("invite: Lapsed")).toBeNull();
  });

  it("shows an invitation-specific empty state, not a jar one", () => {
    invitationsState.data = [];
    render(<JarsScreen />);
    fireEvent.click(screen.getByText("Invited"));
    expect(screen.getByText("No invitations")).toBeTruthy();
    expect(screen.queryByText("Create a Jar")).toBeNull();
  });
});

// ─── Failure must not read as emptiness ──────────────────────────────────────

describe("request failure", () => {
  it("says the request failed rather than claiming the user has no jars", () => {
    // The whole shape of QA item 10 was a wrong-but-plausible empty state.
    jarsState.isError = true;
    jarsState.data = undefined;
    render(<JarsScreen />);
    expect(screen.getByText("Couldn't load your jars")).toBeTruthy();
    expect(screen.queryByText("You don't have any active jars right now.")).toBeNull();
  });
});
