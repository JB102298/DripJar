/**
 * The bottom-tab unread badge.
 *
 * The badge used to be `notifications.filter(n => !n.isRead).length` over the
 * notification LIST — a page. This proves the tab now takes its number from the
 * server's unread total and renders nothing at all when that total is zero,
 * which is what a freshly reset owner must see.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { render, cleanup } from "@testing-library/react";

const { captured, authState, countState, listSpy } = vi.hoisted(() => ({
  captured: {} as Record<string, Record<string, unknown>>,
  authState: { isAuthenticated: true },
  countState: { data: undefined as { unreadCount: number } | undefined },
  listSpy: vi.fn(),
}));

vi.mock("expo-router", async () => {
  const react = await import("react");
  const Tabs = ({ children }: { children?: React.ReactNode }) =>
    react.createElement(react.Fragment, null, children);
  Tabs.Screen = ({ name, options }: { name: string; options: Record<string, unknown> }) => {
    captured[name] = options;
    return null;
  };
  return { Tabs };
});

vi.mock("@workspace/api-client-react", () => ({
  useGetUnreadNotificationCount: () => countState,
  getGetUnreadNotificationCountQueryKey: () => ["/api/notifications/unread-count"],
  // Present so a reintroduction of the page-derived badge is visible as a call
  // rather than as a silently wrong number.
  useListNotifications: listSpy,
  getListNotificationsQueryKey: () => ["/api/notifications"],
}));

vi.mock("@/contexts/auth-context", () => ({ useAuth: () => authState }));

vi.mock("@/hooks/useColors", () => ({
  useColors: () => ({
    background: "#fff", foreground: "#000", card: "#fff", primary: "#178B57",
    primaryForeground: "#fff", secondary: "#E8F6EF", secondaryForeground: "#0E5F3B",
    muted: "#eee", mutedForeground: "#657069", border: "#ddd", destructive: "#C94B4B",
    destructiveForeground: "#fff", success: "#2E9D63", warning: "#D99A25",
    darkGreen: "#0E5F3B", lightGreen: "#E8F6EF", radius: 12,
  }),
}));

vi.mock("@expo/vector-icons", () => ({ Feather: () => null }));
vi.mock("expo-blur", () => ({ BlurView: () => null }));

import TabLayout from "../app/(tabs)/_layout";

const badge = () => {
  render(<TabLayout />);
  return captured["notifications"]?.["tabBarBadge"];
};

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of Object.keys(captured)) delete captured[key];
  authState.isAuthenticated = true;
  countState.data = undefined;
});

afterEach(cleanup);

describe("unread badge", () => {
  it("is completely hidden at zero", () => {
    countState.data = { unreadCount: 0 };
    expect(badge()).toBeUndefined();
  });

  it("is hidden before the count has loaded", () => {
    countState.data = undefined;
    expect(badge()).toBeUndefined();
  });

  it("shows the exact server total", () => {
    countState.data = { unreadCount: 7 };
    expect(badge()).toBe("7");
  });

  it("shows 99 at the cap", () => {
    countState.data = { unreadCount: 99 };
    expect(badge()).toBe("99");
  });

  it("shows 99+ above the cap", () => {
    countState.data = { unreadCount: 100 };
    expect(badge()).toBe("99+");
  });

  it("shows 99+ for a very large total", () => {
    countState.data = { unreadCount: 4321 };
    expect(badge()).toBe("99+");
  });

  it("is hidden when signed out, whatever is left in the cache", () => {
    // Belt and braces alongside auth-context clearing the cache: even a stale
    // cached count cannot render a badge for a signed-out session.
    authState.isAuthenticated = false;
    countState.data = { unreadCount: 12 };
    expect(badge()).toBeUndefined();
  });

  it("does not derive the count from the notification list", () => {
    countState.data = { unreadCount: 3 };
    badge();
    expect(listSpy, "the tab layout is reading the notification list again").not.toHaveBeenCalled();
  });

  it("still registers every tab", () => {
    countState.data = { unreadCount: 0 };
    render(<TabLayout />);
    expect(Object.keys(captured).sort()).toEqual([
      "activity",
      "index",
      "jars",
      "notifications",
      "profile",
    ]);
  });
});
