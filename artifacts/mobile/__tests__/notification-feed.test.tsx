/**
 * The notification feed hook: where the badge number comes from, what an
 * optimistic read does, and what happens when it fails.
 *
 * Runs the real hook against a real QueryClient with only the generated fetch
 * functions mocked, so the cache behaviour under test is the cache behaviour
 * that ships — not a re-implementation of it.
 *
 * The mocks are backed by a small stateful fake server rather than fixed return
 * values. That matters: every mutation here invalidates and refetches on settle,
 * so a mock that kept returning the pre-read rows would make a correct
 * reconciliation look like a bug. The fake persists reads the way the API does,
 * which is what lets the reconciliation assertions mean anything.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, act, waitFor, cleanup } from "@testing-library/react";

const { api } = vi.hoisted(() => ({
  api: {
    listNotifications: vi.fn(),
    getUnreadNotificationCount: vi.fn(),
    markNotificationRead: vi.fn(),
    markAllNotificationsRead: vi.fn(),
  },
}));

vi.mock("@workspace/api-client-react", () => ({
  listNotifications: api.listNotifications,
  getUnreadNotificationCount: api.getUnreadNotificationCount,
  markNotificationRead: api.markNotificationRead,
  markAllNotificationsRead: api.markAllNotificationsRead,
  getGetUnreadNotificationCountQueryKey: () => ["/api/notifications/unread-count"],
}));

import {
  decremented,
  feedWithAllRead,
  feedWithRowRead,
  isRowUnread,
  NOTIFICATION_FEED_KEY,
  NOTIFICATION_PAGE_SIZE,
  UNREAD_COUNT_KEY,
  useNotificationFeed,
} from "../hooks/useNotificationFeed";

// ─── Fake server ─────────────────────────────────────────────────────────────

// The generated response type. Imported as a type only, so the module mock
// above still governs everything this file executes, while the fixtures stay
// bound to the real contract — a row shape that drifts from it fails typecheck
// rather than passing a test against something the server never sends.
type Row = import("@workspace/api-client-react").Notification;

const row = (id: string, isRead = false): Row => ({
  id,
  userId: "u1",
  type: "general",
  title: `Title ${id}`,
  message: `Message ${id}`,
  isRead,
  relatedJarId: null,
  createdAt: "2026-08-25T10:00:00.000Z",
});

const rows = (n: number, from = 0) => Array.from({ length: n }, (_, i) => row(`n${from + i}`));

/** The server's rows. Tests assign to this; the mocks read and mutate it. */
let stored: Row[] = [];

let queryClient: QueryClient;

function wrapper({ children }: { children: React.ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

function mount() {
  return renderHook(() => useNotificationFeed(), { wrapper });
}

beforeEach(() => {
  vi.clearAllMocks();
  stored = [];
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  api.listNotifications.mockImplementation(
    async (params?: { limit?: number; offset?: number }) => {
      const limit = params?.limit ?? NOTIFICATION_PAGE_SIZE;
      const offset = params?.offset ?? 0;
      return stored.slice(offset, offset + limit).map((r) => ({ ...r }));
    },
  );
  api.getUnreadNotificationCount.mockImplementation(async () => ({
    unreadCount: stored.filter((r) => !r.isRead).length,
  }));
  api.markNotificationRead.mockImplementation(async (id: string) => {
    const found = stored.find((r) => r.id === id);
    if (!found) throw new Error("NotFound");
    found.isRead = true;
    return { ...found };
  });
  api.markAllNotificationsRead.mockImplementation(async () => {
    for (const r of stored) r.isRead = true;
    return { message: "ok" };
  });
});

afterEach(() => {
  cleanup();
  queryClient.clear();
});

// ─── Pure cache transforms ───────────────────────────────────────────────────

describe("cache transforms", () => {
  const feed = { pages: [[row("a"), row("b", true)], [row("c")]], pageParams: [0, 25] };

  it("marks exactly one row read and leaves the rest identical", () => {
    const next = feedWithRowRead(feed, "a")!;
    expect(next.pages[0]![0]!.isRead).toBe(true);
    expect(next.pages[0]![1]).toBe(feed.pages[0]![1]);
    expect(next.pages[1]![0]!.isRead).toBe(false);
  });

  it("marks every loaded row read", () => {
    const next = feedWithAllRead(feed)!;
    expect(next.pages.flat().every((n) => n.isRead)).toBe(true);
  });

  it("reports unread state across pages, and false for an unknown id", () => {
    expect(isRowUnread(feed, "a")).toBe(true);
    expect(isRowUnread(feed, "b")).toBe(false);
    expect(isRowUnread(feed, "c")).toBe(true);
    expect(isRowUnread(feed, "missing")).toBe(false);
    expect(isRowUnread(undefined, "a")).toBe(false);
  });

  it("never decrements below zero", () => {
    expect(decremented({ unreadCount: 3 })).toEqual({ unreadCount: 2 });
    expect(decremented({ unreadCount: 0 })).toEqual({ unreadCount: 0 });
    expect(decremented(undefined)).toEqual({ unreadCount: 0 });
  });
});

// ─── The badge number ────────────────────────────────────────────────────────

describe("unread total", () => {
  it("comes from the server, not from the loaded page", async () => {
    // A full page whose rows are ALL read, while the server reports 140 unread
    // behind it — the exact shape the old `filter(!isRead).length` badge got
    // wrong. Overridden rather than derived so the two cannot agree by accident.
    stored = rows(NOTIFICATION_PAGE_SIZE).map((r) => ({ ...r, isRead: true }));
    api.getUnreadNotificationCount.mockResolvedValue({ unreadCount: 140 });

    const { result } = mount();
    await waitFor(() => expect(result.current.notifications).toHaveLength(25));

    expect(result.current.unreadCount).toBe(140);
    expect(result.current.notifications.filter((n) => !n.isRead)).toHaveLength(0);
  });

  it("does not change when another page is loaded", async () => {
    stored = rows(NOTIFICATION_PAGE_SIZE + 5);

    const { result } = mount();
    await waitFor(() => expect(result.current.notifications).toHaveLength(25));
    expect(result.current.unreadCount).toBe(30);

    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.notifications).toHaveLength(30));

    // Paging is not a read, and the badge is not a page property.
    expect(result.current.unreadCount).toBe(30);
    expect(api.markNotificationRead).not.toHaveBeenCalled();
  });

  it("stops paging when the server returns a short page", async () => {
    stored = rows(3);
    const { result } = mount();
    await waitFor(() => expect(result.current.notifications).toHaveLength(3));
    expect(result.current.hasMore).toBe(false);
  });
});

// ─── Optimistic individual read ──────────────────────────────────────────────

describe("marking one read", () => {
  it("updates the row and the badge before the request resolves", async () => {
    stored = rows(2);

    let release: () => void = () => {};
    const pending = new Promise<void>((r) => { release = r; });
    api.markNotificationRead.mockImplementation(async (id: string) => {
      await pending;
      const found = stored.find((r) => r.id === id)!;
      found.isRead = true;
      return { ...found };
    });

    const { result } = mount();
    await waitFor(() => expect(result.current.notifications).toHaveLength(2));

    act(() => result.current.markRead("n0"));

    await waitFor(() => {
      expect(result.current.notifications.find((n) => n.id === "n0")!.isRead).toBe(true);
      expect(result.current.unreadCount).toBe(1);
    });
    // The request has not resolved, and the server still holds the row unread —
    // so what is on screen came from the optimistic write.
    expect(stored.find((r) => r.id === "n0")!.isRead).toBe(false);
    expect(result.current.notifications.find((n) => n.id === "n1")!.isRead).toBe(false);

    await act(async () => { release(); await pending; });
  });

  it("marks only the tapped row", async () => {
    stored = rows(3);

    const { result } = mount();
    await waitFor(() => expect(result.current.notifications).toHaveLength(3));

    await act(async () => { result.current.markRead("n1"); });

    await waitFor(() =>
      expect(result.current.notifications.map((n) => n.isRead)).toEqual([false, true, false]),
    );
    expect(api.markNotificationRead).toHaveBeenCalledTimes(1);
    expect(api.markNotificationRead).toHaveBeenCalledWith("n1");
    expect(stored.filter((r) => r.isRead).map((r) => r.id)).toEqual(["n1"]);
  });

  it("rolls the row and the badge back together when the request fails", async () => {
    stored = rows(2);
    api.markNotificationRead.mockRejectedValue(new Error("offline"));

    const { result } = mount();
    await waitFor(() => expect(result.current.notifications).toHaveLength(2));

    await act(async () => { result.current.markRead("n0"); });

    await waitFor(() => {
      expect(result.current.notifications.find((n) => n.id === "n0")!.isRead).toBe(false);
      expect(result.current.unreadCount).toBe(2);
    });
  });

  it("reconciles against the server when the optimistic guess was wrong", async () => {
    stored = rows(2);
    // Another device reads the second row while this one is reading the first,
    // so the true answer afterwards is 0 and not the optimistic 1.
    api.markNotificationRead.mockImplementation(async (id: string) => {
      for (const r of stored) r.isRead = true;
      return { ...stored.find((r) => r.id === id)! };
    });

    const { result } = mount();
    await waitFor(() => expect(result.current.unreadCount).toBe(2));

    await act(async () => { result.current.markRead("n0"); });

    await waitFor(() => expect(result.current.unreadCount).toBe(0));
    expect(result.current.notifications.every((n) => n.isRead)).toBe(true);
  });

  it("is stable under repeated taps on the same row", async () => {
    stored = rows(3);

    const { result } = mount();
    await waitFor(() => expect(result.current.notifications).toHaveLength(3));

    await act(async () => {
      result.current.markRead("n0");
      result.current.markRead("n0");
      result.current.markRead("n0");
    });

    await waitFor(() => expect(result.current.notifications[0]!.isRead).toBe(true));

    // One request, one decrement — not three, and never below the server's own
    // number.
    expect(api.markNotificationRead).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(result.current.unreadCount).toBe(2));
  });

  it("does nothing at all for a row that is already read", async () => {
    stored = [row("n0", true)];

    const { result } = mount();
    await waitFor(() => expect(result.current.notifications).toHaveLength(1));

    await act(async () => { result.current.markRead("n0"); });

    expect(api.markNotificationRead).not.toHaveBeenCalled();
    expect(result.current.unreadCount).toBe(0);
  });
});

// ─── Mark all read ───────────────────────────────────────────────────────────

describe("marking all read", () => {
  it("zeroes the badge and every loaded row at once", async () => {
    stored = rows(3);

    const { result } = mount();
    await waitFor(() => expect(result.current.unreadCount).toBe(3));

    await act(async () => { result.current.markAllRead(); });

    await waitFor(() => {
      expect(result.current.unreadCount).toBe(0);
      expect(result.current.notifications.every((n) => n.isRead)).toBe(true);
    });
    expect(api.markAllNotificationsRead).toHaveBeenCalledTimes(1);
  });

  it("clears rows the client never loaded", async () => {
    stored = rows(60);

    const { result } = mount();
    await waitFor(() => expect(result.current.unreadCount).toBe(60));
    expect(result.current.notifications).toHaveLength(25);

    await act(async () => { result.current.markAllRead(); });

    await waitFor(() => expect(result.current.unreadCount).toBe(0));
    expect(stored.every((r) => r.isRead)).toBe(true);
  });

  it("restores the previous state when the request fails", async () => {
    stored = rows(2);
    api.markAllNotificationsRead.mockRejectedValue(new Error("offline"));

    const { result } = mount();
    await waitFor(() => expect(result.current.unreadCount).toBe(2));

    await act(async () => { result.current.markAllRead(); });

    await waitFor(() => {
      expect(result.current.unreadCount).toBe(2);
      expect(result.current.notifications.every((n) => !n.isRead)).toBe(true);
    });
  });
});

// ─── Refresh ─────────────────────────────────────────────────────────────────

describe("refresh", () => {
  it("re-reads both the page and the unread total", async () => {
    stored = rows(1);

    const { result } = mount();
    await waitFor(() => expect(result.current.notifications).toHaveLength(1));

    const listCalls = api.listNotifications.mock.calls.length;
    const countCalls = api.getUnreadNotificationCount.mock.calls.length;

    await act(async () => { await result.current.refresh(); });

    expect(api.listNotifications.mock.calls.length).toBeGreaterThan(listCalls);
    expect(api.getUnreadNotificationCount.mock.calls.length).toBeGreaterThan(countCalls);
  });

  it("picks up a notification created while the screen was away", async () => {
    stored = rows(1);
    const { result } = mount();
    await waitFor(() => expect(result.current.unreadCount).toBe(1));

    stored = [row("fresh"), ...stored];
    await act(async () => { await result.current.refresh(); });

    await waitFor(() => {
      expect(result.current.unreadCount).toBe(2);
      expect(result.current.notifications[0]!.id).toBe("fresh");
    });
  });

  it("keeps a stable identity so a focus effect does not loop", async () => {
    const { result, rerender } = mount();
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    const first = result.current.refresh;
    rerender();
    expect(result.current.refresh).toBe(first);
  });

  it("does not mark anything read", async () => {
    stored = rows(2);

    const { result } = mount();
    await waitFor(() => expect(result.current.notifications).toHaveLength(2));
    await act(async () => { await result.current.refresh(); });

    expect(api.markNotificationRead).not.toHaveBeenCalled();
    expect(api.markAllNotificationsRead).not.toHaveBeenCalled();
    expect(result.current.unreadCount).toBe(2);
    expect(stored.every((r) => !r.isRead)).toBe(true);
  });
});

// ─── Failure is not emptiness ────────────────────────────────────────────────

describe("error state", () => {
  it("reports an error rather than an empty list", async () => {
    api.listNotifications.mockRejectedValue(new Error("network"));

    const { result } = mount();
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.notifications).toEqual([]);
    expect(result.current.isLoading).toBe(false);
  });
});

// ─── Cache isolation ─────────────────────────────────────────────────────────

describe("cache keys", () => {
  it("stores the feed and the count under distinct keys", () => {
    expect(NOTIFICATION_FEED_KEY).not.toEqual(UNREAD_COUNT_KEY);
  });

  it("leaves nothing behind when the client is cleared", async () => {
    stored = rows(9);

    const { result } = mount();
    await waitFor(() => expect(result.current.unreadCount).toBe(9));

    // What auth-context does on sign-out and sign-in.
    queryClient.clear();

    expect(queryClient.getQueryData(UNREAD_COUNT_KEY)).toBeUndefined();
    expect(queryClient.getQueryData(NOTIFICATION_FEED_KEY)).toBeUndefined();
  });
});
