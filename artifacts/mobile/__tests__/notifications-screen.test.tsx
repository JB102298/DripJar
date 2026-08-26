/**
 * The Notifications screen.
 *
 * Guards specifically against what was there before:
 *   - `markAsRead` was an empty stub, so tapping a row never marked it read
 *   - there was no "Mark all as read" control at all
 *   - a failed request rendered the "You're all caught up" empty state, telling
 *     an account whose request failed that it had nothing
 *   - unread was signalled by a background tint and a coloured dot, with no
 *     accessible state and no text
 *   - every notification that was not jar-shaped fell into an empty `else`
 *
 * Data behaviour lives in notification-feed.test.tsx and routing in
 * notification-presentation.test.ts; this file is about what the screen renders
 * and what it does when a row is tapped.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { render, cleanup, fireEvent, screen } from "@testing-library/react";

const { feedState, feedActions } = vi.hoisted(() => ({
  feedState: {
    notifications: [] as unknown[],
    unreadCount: 0,
    isLoading: false,
    isError: false,
    isRefreshing: false,
    hasMore: false,
    isLoadingMore: false,
    isMarkingAllRead: false,
  },
  feedActions: {
    loadMore: vi.fn(),
    refresh: vi.fn(async () => {}),
    markRead: vi.fn(),
    markAllRead: vi.fn(),
  },
}));

vi.mock("@/hooks/useNotificationFeed", () => ({
  useNotificationFeed: () => ({ ...feedState, ...feedActions }),
}));

const mockPush = vi.fn();
vi.mock("expo-router", async () => {
  const react = await import("react");
  return {
    useRouter: () => ({ push: mockPush, replace: vi.fn(), back: vi.fn() }),
    // Real effect semantics, so a callback with an unstable identity would show
    // up here as a runaway loop rather than passing silently.
    useFocusEffect: (cb: () => void) => react.useEffect(cb, [cb]),
  };
});

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

import NotificationsScreen from "../app/(tabs)/notifications";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const JAR = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

const notification = (over: Partial<Record<string, unknown>> = {}) => ({
  id: "n1",
  userId: "u1",
  type: "general",
  title: "Something happened",
  message: "Here is what happened.",
  isRead: false,
  relatedJarId: JAR,
  relatedJarName: "Trip Fund",
  actionUrl: null,
  createdAt: new Date().toISOString(),
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  feedState.notifications = [];
  feedState.unreadCount = 0;
  feedState.isLoading = false;
  feedState.isError = false;
  feedState.isRefreshing = false;
  feedState.hasMore = false;
  feedState.isLoadingMore = false;
  feedState.isMarkingAllRead = false;
});

afterEach(cleanup);

// ─── Four distinct states ────────────────────────────────────────────────────

describe("screen states", () => {
  it("shows a clean empty state for a verified owner with no notifications", () => {
    render(<NotificationsScreen />);

    expect(screen.getByTestId("notifications-empty")).toBeTruthy();
    expect(screen.getByText("You're all caught up")).toBeTruthy();
    expect(screen.queryByTestId("notifications-error")).toBeNull();
    expect(screen.queryByTestId("notifications-loading")).toBeNull();
  });

  it("shows no sample, seeded, or placeholder notification when empty", () => {
    render(<NotificationsScreen />);

    // The seed's literals, which were the whole of the QA contradiction.
    expect(screen.queryByText(/Hawaii/i)).toBeNull();
    expect(screen.queryByText(/71%/)).toBeNull();
    expect(screen.queryByText(/Flights are fully funded/i)).toBeNull();
    expect(screen.queryByText(/\$/)).toBeNull();
  });

  it("distinguishes loading from empty", () => {
    feedState.isLoading = true;
    render(<NotificationsScreen />);

    expect(screen.getByTestId("notifications-loading")).toBeTruthy();
    expect(screen.queryByTestId("notifications-empty")).toBeNull();
    expect(screen.queryByText("You're all caught up")).toBeNull();
  });

  it("distinguishes a failed request from an empty account", () => {
    feedState.isError = true;
    render(<NotificationsScreen />);

    expect(screen.getByTestId("notifications-error")).toBeTruthy();
    expect(screen.queryByTestId("notifications-empty")).toBeNull();
    // The exact defect: a failed load must never say "you're all caught up".
    expect(screen.queryByText("You're all caught up")).toBeNull();
    expect(screen.getByText("We couldn't load your notifications")).toBeTruthy();
  });

  it("offers a retry from the error state", () => {
    feedState.isError = true;
    render(<NotificationsScreen />);

    feedActions.refresh.mockClear();
    fireEvent.click(screen.getByText("Try again"));
    expect(feedActions.refresh).toHaveBeenCalled();
  });

  it("renders rows when populated", () => {
    feedState.notifications = [
      notification({ id: "a", title: "First" }),
      notification({ id: "b", title: "Second" }),
    ];
    render(<NotificationsScreen />);

    expect(screen.getByText("First")).toBeTruthy();
    expect(screen.getByText("Second")).toBeTruthy();
    expect(screen.queryByTestId("notifications-empty")).toBeNull();
  });
});

// ─── Canonical content ───────────────────────────────────────────────────────

describe("content is the server's", () => {
  it("renders title and message verbatim", () => {
    feedState.notifications = [
      notification({
        title: "Jordan added $1,250.00 to Trip Fund",
        message: "Trip Fund is now 42.5% funded.",
      }),
    ];
    render(<NotificationsScreen />);

    expect(screen.getByText("Jordan added $1,250.00 to Trip Fund")).toBeTruthy();
    expect(screen.getByText("Trip Fund is now 42.5% funded.")).toBeTruthy();
  });

  it("does not recompute an amount or a percentage", () => {
    // If the screen derived either figure it would have to invent inputs it
    // does not have; the only money-shaped text on screen is the server's own.
    feedState.notifications = [
      notification({ title: "Saved $7.00", message: "You are 1% of the way there." }),
    ];
    const { container } = render(<NotificationsScreen />);

    const text = container.textContent ?? "";
    const money = text.match(/\$[\d,.]+/g) ?? [];
    const percents = text.match(/[\d.]+%/g) ?? [];
    expect(money).toEqual(["$7.00"]);
    expect(percents).toEqual(["1%"]);
  });

  it("does not display internal identifiers", () => {
    feedState.notifications = [notification({ id: "n-secret", relatedJarId: JAR })];
    const { container } = render(<NotificationsScreen />);

    const text = container.textContent ?? "";
    expect(text).not.toContain(JAR);
    expect(text).not.toContain("n-secret");
    expect(text).not.toContain("u1");
  });
});

// ─── Unread vs read ──────────────────────────────────────────────────────────

describe("unread presentation", () => {
  it("marks unread rows with text, not colour alone", () => {
    feedState.notifications = [notification({ id: "a", isRead: false })];
    feedState.unreadCount = 1;
    render(<NotificationsScreen />);

    expect(screen.getByText("New")).toBeTruthy();
  });

  it("shows no unread marker on a read row", () => {
    feedState.notifications = [notification({ id: "a", isRead: true })];
    render(<NotificationsScreen />);

    expect(screen.queryByText("New")).toBeNull();
  });

  it("announces read state to a screen reader", () => {
    feedState.notifications = [
      notification({ id: "a", title: "Unread one", message: "Body.", isRead: false }),
      notification({ id: "b", title: "Read one", message: "Body.", isRead: true }),
    ];
    render(<NotificationsScreen />);

    expect(screen.getByLabelText("Unread. Unread one. Body.")).toBeTruthy();
    expect(screen.getByLabelText("Read. Read one. Body.")).toBeTruthy();
  });

  it("exposes each row as a button", () => {
    feedState.notifications = [notification({ id: "a" })];
    render(<NotificationsScreen />);

    expect(screen.getAllByRole("button").length).toBeGreaterThan(0);
  });
});

// ─── Mark all as read ────────────────────────────────────────────────────────

describe("mark all as read", () => {
  it("is offered only when unread notifications exist", () => {
    feedState.notifications = [notification({ id: "a", isRead: false })];
    feedState.unreadCount = 3;
    render(<NotificationsScreen />);

    expect(screen.getByTestId("mark-all-read")).toBeTruthy();
  });

  it("is absent when everything is read", () => {
    feedState.notifications = [notification({ id: "a", isRead: true })];
    feedState.unreadCount = 0;
    render(<NotificationsScreen />);

    expect(screen.queryByTestId("mark-all-read")).toBeNull();
  });

  it("is absent on an empty account", () => {
    render(<NotificationsScreen />);
    expect(screen.queryByTestId("mark-all-read")).toBeNull();
  });

  it("marks all read when pressed", () => {
    feedState.notifications = [notification({ id: "a" })];
    feedState.unreadCount = 2;
    render(<NotificationsScreen />);

    fireEvent.click(screen.getByTestId("mark-all-read"));
    expect(feedActions.markAllRead).toHaveBeenCalledTimes(1);
  });
});

// ─── Opening the list ────────────────────────────────────────────────────────

describe("opening the list", () => {
  it("refreshes on focus", () => {
    feedState.notifications = [notification({ id: "a" })];
    render(<NotificationsScreen />);

    expect(feedActions.refresh).toHaveBeenCalled();
  });

  it("does not silently mark anything read", () => {
    feedState.notifications = [
      notification({ id: "a", isRead: false }),
      notification({ id: "b", isRead: false }),
    ];
    feedState.unreadCount = 2;
    render(<NotificationsScreen />);

    expect(feedActions.markRead).not.toHaveBeenCalled();
    expect(feedActions.markAllRead).not.toHaveBeenCalled();
  });
});

// ─── Tapping ─────────────────────────────────────────────────────────────────

describe("tapping a notification", () => {
  const tap = (id: string) => fireEvent.click(screen.getByTestId(`notification-${id}`));

  it("marks only that row read", () => {
    feedState.notifications = [notification({ id: "a" }), notification({ id: "b" })];
    feedState.unreadCount = 2;
    render(<NotificationsScreen />);

    tap("a");
    expect(feedActions.markRead).toHaveBeenCalledTimes(1);
    expect(feedActions.markRead).toHaveBeenCalledWith("a");
  });

  it.each([
    ["milestone_funded", `/jar/${JAR}?tab=Milestones`],
    ["member_joined", `/jar/${JAR}?tab=Members`],
    ["agreement_required", `/jar/${JAR}?tab=Agreements`],
    ["contribution_recorded", `/jar/${JAR}?tab=Activity`],
    ["goal_fully_funded", `/jar/${JAR}`],
    ["jar_halfway_funded", `/jar/${JAR}`],
    ["cutoff_reached", `/jar/${JAR}`],
    ["autodrip_needs_attention", `/jar/${JAR}/autodrip`],
    ["invitation_received", "/(tabs)/jars"],
  ])("sends %s to %s", (type, href) => {
    feedState.notifications = [notification({ id: "a", type })];
    render(<NotificationsScreen />);

    tap("a");
    expect(mockPush).toHaveBeenCalledWith(href);
  });

  it("stays on the list for a type with no safe destination, but still marks it read", () => {
    feedState.notifications = [notification({ id: "a", type: "general", relatedJarId: null })];
    render(<NotificationsScreen />);

    tap("a");
    expect(feedActions.markRead).toHaveBeenCalledWith("a");
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("handles an unknown type without crashing", () => {
    feedState.notifications = [
      notification({ id: "a", type: "type_from_a_newer_server", relatedJarId: JAR }),
      notification({ id: "b", type: "legacy_type", relatedJarId: null }),
    ];
    expect(() => render(<NotificationsScreen />)).not.toThrow();

    tap("a");
    expect(mockPush).toHaveBeenCalledWith(`/jar/${JAR}`);

    mockPush.mockClear();
    tap("b");
    expect(mockPush).not.toHaveBeenCalled();
    expect(feedActions.markRead).toHaveBeenCalledWith("b");
  });

  it("never navigates to a route named by actionUrl", () => {
    feedState.notifications = [
      notification({ id: "a", type: "general", relatedJarId: JAR, actionUrl: "/(auth)/login" }),
    ];
    render(<NotificationsScreen />);

    tap("a");
    expect(mockPush).toHaveBeenCalledWith(`/jar/${JAR}`);
    expect(mockPush).not.toHaveBeenCalledWith("/(auth)/login");
  });

  it("leaves an already-read row's read call to the hook and still navigates", () => {
    feedState.notifications = [notification({ id: "a", isRead: true })];
    render(<NotificationsScreen />);

    tap("a");
    // The screen always asks; the hook is what decides a read row needs no
    // request (see notification-feed.test.tsx).
    expect(feedActions.markRead).toHaveBeenCalledWith("a");
    expect(mockPush).toHaveBeenCalledWith(`/jar/${JAR}`);
  });

  it("is consistent when the same row is tapped repeatedly", () => {
    feedState.notifications = [notification({ id: "a" })];
    render(<NotificationsScreen />);

    tap("a");
    tap("a");
    tap("a");

    expect(feedActions.markRead).toHaveBeenCalledTimes(3);
    expect(feedActions.markRead.mock.calls.every(([id]) => id === "a")).toBe(true);
  });
});

// ─── Paging ──────────────────────────────────────────────────────────────────

describe("paging", () => {
  it("shows a footer indicator while another page loads", () => {
    feedState.notifications = [notification({ id: "a" })];
    feedState.hasMore = true;
    feedState.isLoadingMore = true;
    render(<NotificationsScreen />);

    expect(screen.getByTestId("notifications-loading-more")).toBeTruthy();
  });

  it("shows no footer indicator when there is nothing more", () => {
    feedState.notifications = [notification({ id: "a" })];
    render(<NotificationsScreen />);

    expect(screen.queryByTestId("notifications-loading-more")).toBeNull();
  });
});
