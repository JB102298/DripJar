/**
 * Home — the first-use empty state.
 *
 * After the owner-QA reset, `jordan@dripjar.dev` signs in to a dashboard where
 * `totalJars` is 0 and `featuredJar` is null. That is the first screen a brand
 * new account ever sees, so the call to action is pinned here: a generic
 * "Create a Jar" reads like a toolbar button, and the approved first-use
 * wording is "Create Your First Jar".
 *
 * Also guards the failure this screen is one line away from: `hasJars` is
 * `dashboard && dashboard.totalJars > 0`, so an undefined dashboard renders the
 * empty state too. An account whose dashboard request failed must not be told
 * it has nothing — the same defect already fixed on My Jars.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { render, cleanup, fireEvent, screen } from "@testing-library/react";

const { dashboardState } = vi.hoisted(() => ({
  dashboardState: {
    data: undefined as unknown,
    isLoading: false,
  },
}));

vi.mock("@workspace/api-client-react", () => ({
  useGetDashboard: () => ({ ...dashboardState, refetch: vi.fn() }),
}));

const mockPush = vi.fn();
vi.mock("expo-router", () => ({
  useRouter: () => ({ push: mockPush, replace: vi.fn(), back: vi.fn() }),
}));

vi.mock("@/contexts/auth-context", () => ({
  useAuth: () => ({ profile: { displayName: "Jordan Barrett", firstName: "Jordan" } }),
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
vi.mock("@/components/BrandLogo", () => ({ BrandLogo: () => <div data-testid="brand-logo" /> }));
vi.mock("@/components/MemberAvatar", () => ({ MemberAvatar: () => null }));
vi.mock("@/components/ProgressBar", () => ({ ProgressBar: () => null }));
vi.mock("@/components/CircularProgress", () => ({ CircularProgress: () => null }));
vi.mock("@/components/JarHealthBadge", () => ({ JarHealthBadge: () => null }));
vi.mock("expo-image", () => ({ ImageBackground: ({ children }: { children?: React.ReactNode }) => <div>{children}</div> }));
vi.mock("expo-linear-gradient", () => ({ LinearGradient: ({ children }: { children?: React.ReactNode }) => <div>{children}</div> }));
vi.mock("expo-haptics", () => ({ impactAsync: vi.fn(), ImpactFeedbackStyle: { Light: "light" } }));

import HomeScreen from "../app/(tabs)/index";

/** The shape GET /api/dashboard returns for a freshly reset owner. */
const EMPTY_DASHBOARD = {
  featuredJar: null,
  personalProgress: null,
  memberProgress: [],
  upcomingActivity: [],
  recentContributions: [],
  totalJars: 0,
  activeJars: 0,
  unreadNotifications: 0,
};

beforeEach(() => {
  dashboardState.data = undefined;
  dashboardState.isLoading = false;
  mockPush.mockClear();
});
afterEach(cleanup);

describe("Home first-use empty state", () => {
  it("uses the approved first-use call to action", () => {
    dashboardState.data = EMPTY_DASHBOARD;
    render(<HomeScreen />);

    expect(screen.getByText("Create Your First Jar")).toBeTruthy();
    // The generic label must not come back.
    expect(screen.queryByText("Create a Jar")).toBeNull();
  });

  it("names the empty state and keeps the supporting copy to one line", () => {
    dashboardState.data = EMPTY_DASHBOARD;
    render(<HomeScreen />);

    expect(screen.getByText("You don't have any Jars yet")).toBeTruthy();

    const description = screen.getByText(
      "Set a goal, invite the people saving with you, and watch it fill up.",
    );
    expect(description).toBeTruthy();
    expect(description.textContent!.length).toBeLessThanOrEqual(90);
  });

  it("sends the call to action to the create-jar flow", () => {
    dashboardState.data = EMPTY_DASHBOARD;
    render(<HomeScreen />);

    fireEvent.click(screen.getByText("Create Your First Jar"));
    expect(mockPush).toHaveBeenCalledWith("/create-jar");
  });

  it("still greets the owner rather than rendering a bare screen", () => {
    dashboardState.data = EMPTY_DASHBOARD;
    render(<HomeScreen />);
    expect(screen.getByTestId("brand-logo")).toBeTruthy();
    expect(screen.getByText(/Jordan/)).toBeTruthy();
  });

  it("shows no jar content at all when the account is empty", () => {
    dashboardState.data = EMPTY_DASHBOARD;
    render(<HomeScreen />);
    // Nothing from the populated branch should leak through.
    expect(screen.queryByText(/Hawaii/)).toBeNull();
    expect(screen.queryByText(/saved/i)).toBeNull();
  });
});
