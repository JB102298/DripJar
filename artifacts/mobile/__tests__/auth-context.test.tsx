/**
 * Mobile auth-context behavior tests (Task 4 final verification, spec tests 20–22).
 *
 * Runs the real AuthProvider from contexts/auth-context.tsx under jsdom with
 * expo-secure-store, AsyncStorage, and the generated API hooks mocked.
 * No device or emulator is required.
 *
 * Covers:
 *  - two concurrent refresh callers result in exactly ONE refresh fetch (mutex)
 *  - both callers receive the SAME refresh result
 *  - terminal refresh failure (401) deletes BOTH SecureStore keys
 *  - an original API request is never retried more than once (the client uses
 *    proactive refresh with zero automatic retries — a 401 from customFetch
 *    performs exactly one network call and throws; no retry loop exists)
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import React, { useEffect } from "react";
import { render, waitFor, act } from "@testing-library/react";

// ─── In-memory token-storage mock ────────────────────────────────────────────
//
// auth-context now talks to the platform-agnostic `@/lib/token-storage` seam
// rather than calling expo-secure-store directly, so the mock moved here. The
// behaviour under test is unchanged — this still asserts that a terminal
// refresh failure deletes BOTH token keys.

// vi.hoisted runs before the hoisted vi.mock factories, so the shared Map and
// its spies exist by the time auth-context is imported. Declaring them as plain
// top-level consts would fail with "Cannot access 'storageMock' before
// initialization".
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
  default: {
    getItem: vi.fn(async () => null),
    removeItem: vi.fn(async () => undefined),
  },
}));

// ─── API client mock — capture the auth token getter ────────────────────────

type Getter = () => Promise<string | null> | string | null;
let capturedGetter: Getter | null = null;

vi.mock("@workspace/api-client-react", () => ({
  setBaseUrl: vi.fn(),
  setAuthTokenGetter: vi.fn((g: Getter | null) => {
    capturedGetter = g;
  }),
  useGetMe: vi.fn(() => ({ data: undefined, isLoading: false, refetch: vi.fn() })),
  useLogin: vi.fn(() => ({})),
  useRegister: vi.fn(() => ({})),
  getGetMeQueryKey: vi.fn(() => ["me"]),
}));

// (auth-context's `import type … from "…/api.schemas"` is type-only and
// erased at transform time — no runtime mock needed.)

import { AuthProvider, useAuth } from "../contexts/auth-context";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const ACCESS_KEY = "tripjar_access_token";
const REFRESH_KEY = "tripjar_refresh_token";

/** Build an unsigned JWT with the given expiry offset (seconds from now). */
function makeJwt(expOffsetSec: number): string {
  const payload = btoa(
    JSON.stringify({ exp: Math.floor(Date.now() / 1000) + expOffsetSec }),
  );
  return `${btoa(JSON.stringify({ alg: "none" }))}.${payload}.sig`;
}

function jsonResponse(status: number, body: unknown, delayMs = 0): Promise<Response> {
  const res = new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
  return delayMs
    ? new Promise((r) => setTimeout(() => r(res), delayMs))
    : Promise.resolve(res);
}

let authApi: ReturnType<typeof useAuth> | null = null;

function Consumer() {
  const auth = useAuth();
  useEffect(() => {
    authApi = auth;
  });
  return null;
}

async function mountWithLoggedInUser(expiredAccessToken: string) {
  // fetch for the login call
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      jsonResponse(200, { token: expiredAccessToken, refreshToken: "refresh-original" }),
    ),
  );

  render(
    <AuthProvider>
      <Consumer />
    </AuthProvider>,
  );
  await waitFor(() => expect(authApi).not.toBeNull());

  await act(async () => {
    await authApi!.login({ email: "a@b.c", password: "x" } as never);
  });

  expect(capturedGetter).not.toBeNull();
}

beforeEach(() => {
  secureStore.clear();
  capturedGetter = null;
  authApi = null;
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("Refresh mutex — concurrent callers deduplicated (spec test 20)", () => {
  it("two concurrent refresh callers result in one refresh fetch, same result for both", async () => {
    await mountWithLoggedInUser(makeJwt(-60)); // access token already expired

    const freshToken = makeJwt(900);
    const refreshFetch = vi.fn((url: RequestInfo | URL) => {
      expect(String(url)).toContain("/api/auth/refresh");
      // Delay so the second caller arrives while the first is in flight
      return jsonResponse(200, { token: freshToken, refreshToken: "refresh-rotated" }, 50);
    });
    vi.stubGlobal("fetch", refreshFetch);

    // Expired access token ⇒ the auth getter triggers doRefresh.
    let r1: string | null = null;
    let r2: string | null = null;
    await act(async () => {
      [r1, r2] = await Promise.all([
        Promise.resolve(capturedGetter!()),
        Promise.resolve(capturedGetter!()),
      ]);
    });

    expect(refreshFetch).toHaveBeenCalledTimes(1); // exactly ONE network refresh
    expect(r1).toBe(freshToken);
    expect(r2).toBe(freshToken); // both callers share the same result
    expect(secureStore.get(REFRESH_KEY)).toBe("refresh-rotated");
  });
});

describe("Terminal refresh failure — SecureStore cleared (spec test 22)", () => {
  it("a 401 refresh deletes both SecureStore keys and returns null", async () => {
    await mountWithLoggedInUser(makeJwt(-60));
    expect(secureStore.has(ACCESS_KEY)).toBe(true);
    expect(secureStore.has(REFRESH_KEY)).toBe(true);

    const refreshFetch = vi.fn(() => jsonResponse(401, { error: "Unauthorized" }));
    vi.stubGlobal("fetch", refreshFetch);

    let result: string | null = "sentinel";
    await act(async () => {
      result = await capturedGetter!();
    });

    expect(result).toBeNull();
    expect(refreshFetch).toHaveBeenCalledTimes(1); // no retry of the refresh
    expect(secureStore.has(ACCESS_KEY)).toBe(false);
    expect(secureStore.has(REFRESH_KEY)).toBe(false);
    expect(storageMock.deleteItem).toHaveBeenCalledWith(ACCESS_KEY);
    expect(storageMock.deleteItem).toHaveBeenCalledWith(REFRESH_KEY);
  });

  it("a network error during refresh also clears both keys (no infinite retry)", async () => {
    await mountWithLoggedInUser(makeJwt(-60));

    const refreshFetch = vi.fn(() => Promise.reject(new TypeError("Network request failed")));
    vi.stubGlobal("fetch", refreshFetch);

    let result: string | null = "sentinel";
    await act(async () => {
      result = await capturedGetter!();
    });

    expect(result).toBeNull();
    expect(refreshFetch).toHaveBeenCalledTimes(1);
    expect(secureStore.has(ACCESS_KEY)).toBe(false);
    expect(secureStore.has(REFRESH_KEY)).toBe(false);
  });
});

describe("Original API request retried at most once (spec test 21)", () => {
  it("customFetch performs exactly one network call on 401 — no retry loop exists", async () => {
    // Import the REAL customFetch (the hooks module is mocked above, so pull
    // it straight from its source module).
    const { customFetch, ApiError } = await import(
      "../../../lib/api-client-react/src/custom-fetch"
    );

    const apiFetch = vi.fn(() => jsonResponse(401, { error: "Unauthorized" }));
    vi.stubGlobal("fetch", apiFetch);

    await expect(
      customFetch("https://api.test/api/jars", { method: "GET" }),
    ).rejects.toBeInstanceOf(ApiError);

    // Exactly one network call: the original request is never auto-retried,
    // so retries are trivially bounded at zero (< 1) and cannot loop.
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it("valid cached access token is returned without any network call", async () => {
    await mountWithLoggedInUser(makeJwt(900)); // still-valid token

    const netFetch = vi.fn();
    vi.stubGlobal("fetch", netFetch);

    const token = await capturedGetter!();
    expect(token).toBe(secureStore.get(ACCESS_KEY));
    expect(netFetch).not.toHaveBeenCalled();
  });
});
