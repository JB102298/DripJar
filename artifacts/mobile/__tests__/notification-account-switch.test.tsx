/**
 * Cross-account cache isolation.
 *
 * The QueryClient is a process-lifetime singleton. Before this change nothing
 * ever cleared it, so a cached unread count — and every other cached response —
 * survived sign-out and was served to the next account that signed in. Gating
 * the badge query on `isAuthenticated` did not help: React Query hands back the
 * cached value first and refetches afterwards, so the incoming user saw the
 * previous user's badge for as long as the request took.
 *
 * Runs the real AuthProvider against the real shared client, with only storage
 * and the generated hooks mocked.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import React, { useEffect } from "react";
import { render, act, waitFor, cleanup } from "@testing-library/react";

const { secureStore, storageMock } = vi.hoisted(() => {
  const store = new Map<string, string>();
  return {
    secureStore: store,
    storageMock: {
      getItem: vi.fn(async (k: string) => store.get(k) ?? null),
      setItem: vi.fn(async (k: string, v: string) => void store.set(k, v)),
      deleteItem: vi.fn(async (k: string) => void store.delete(k)),
      storageBackend: "localStorage" as const,
    },
  };
});

vi.mock("@/lib/token-storage", () => storageMock);

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: { getItem: vi.fn(async () => null), removeItem: vi.fn(async () => undefined) },
}));

vi.mock("@workspace/api-client-react", () => ({
  setBaseUrl: vi.fn(),
  setAuthTokenGetter: vi.fn(),
  useGetMe: vi.fn(() => ({ data: undefined, isLoading: false, refetch: vi.fn() })),
  useLogin: vi.fn(() => ({})),
  useRegister: vi.fn(() => ({})),
  getGetMeQueryKey: vi.fn(() => ["me"]),
}));

import { queryClient } from "../lib/query-client";
import { AuthProvider, useAuth } from "../contexts/auth-context";

// The key the badge reads. Written directly so this test does not depend on the
// notification hook's internals.
const UNREAD_KEY = ["/api/notifications/unread-count"];
const FEED_KEY = ["/api/notifications", "feed"];

function jsonResponse(status: number, body: unknown): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

let authApi: ReturnType<typeof useAuth> | null = null;

function Consumer() {
  const auth = useAuth();
  useEffect(() => {
    authApi = auth;
  });
  return null;
}

/** Seed the cache the way a signed-in session would have filled it. */
function seedPreviousUserCache() {
  queryClient.setQueryData(UNREAD_KEY, { unreadCount: 12 });
  queryClient.setQueryData(FEED_KEY, {
    pages: [[{ id: "other-users-notification", isRead: false }]],
    pageParams: [0],
  });
  queryClient.setQueryData(["/api/dashboard"], { unreadNotifications: 12 });
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  secureStore.clear();
  queryClient.clear();
  authApi = null;
});

async function mount() {
  render(
    <AuthProvider>
      <Consumer />
    </AuthProvider>,
  );
  await waitFor(() => expect(authApi).not.toBeNull());
}

describe("signing out", () => {
  it("clears the previous account's unread count", async () => {
    vi.stubGlobal("fetch", vi.fn(() => jsonResponse(200, { ok: true })));
    await mount();
    seedPreviousUserCache();
    expect(queryClient.getQueryData(UNREAD_KEY)).toEqual({ unreadCount: 12 });

    await act(async () => {
      await authApi!.logout();
    });

    expect(queryClient.getQueryData(UNREAD_KEY)).toBeUndefined();
  });

  it("clears every cached response, not just the ones named here", async () => {
    vi.stubGlobal("fetch", vi.fn(() => jsonResponse(200, { ok: true })));
    await mount();
    seedPreviousUserCache();

    await act(async () => {
      await authApi!.logout();
    });

    // Whole-cache clear, so a query added later cannot leak by being forgotten
    // from a key list.
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
  });

  it("clears even when the server-side logout call fails", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("offline"))));
    await mount();
    seedPreviousUserCache();

    await act(async () => {
      await authApi!.logout();
    });

    expect(queryClient.getQueryData(UNREAD_KEY)).toBeUndefined();
  });
});

describe("signing in as a different account", () => {
  it("does not inherit the previous account's unread count", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => jsonResponse(200, { token: "new-access", refreshToken: "new-refresh" })),
    );
    await mount();
    seedPreviousUserCache();

    await act(async () => {
      await authApi!.login({ email: "second@dripjar.dev", password: "P@ssword1!" } as never);
    });

    expect(queryClient.getQueryData(UNREAD_KEY)).toBeUndefined();
    expect(queryClient.getQueryData(FEED_KEY)).toBeUndefined();
  });

  it("does not inherit it after registering either", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => jsonResponse(200, { token: "new-access", refreshToken: "new-refresh" })),
    );
    await mount();
    seedPreviousUserCache();

    await act(async () => {
      await authApi!.register({
        email: "third@dripjar.dev",
        password: "P@ssword1!",
        firstName: "Third",
        lastName: "User",
      } as never);
    });

    expect(queryClient.getQueryData(UNREAD_KEY)).toBeUndefined();
  });

  it("does not disturb the current session when the sign-in fails", async () => {
    vi.stubGlobal("fetch", vi.fn(() => jsonResponse(401, { message: "Invalid credentials" })));
    await mount();
    seedPreviousUserCache();

    await act(async () => {
      await expect(
        authApi!.login({ email: "wrong@dripjar.dev", password: "nope" } as never),
      ).rejects.toThrow();
    });

    // No identity change happened — whoever was signed in still is — so their
    // own cache is theirs to keep. Clearing here would blank a signed-in user's
    // screen because somebody mistyped a password.
    expect(queryClient.getQueryData(UNREAD_KEY)).toEqual({ unreadCount: 12 });
  });
});
