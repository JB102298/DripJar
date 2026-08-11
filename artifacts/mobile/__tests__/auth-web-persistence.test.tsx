/**
 * Auth persistence on web — end-to-end through the real storage adapter.
 *
 * Unlike auth-context.test.tsx, which mocks `@/lib/token-storage` to isolate
 * refresh-mutex behaviour, this suite lets AuthProvider talk to the REAL web
 * adapter backed by jsdom's localStorage. That is what actually broke in the
 * browser: expo-secure-store's methods are undefined on web, so login threw
 * `setValueWithKeyAsync is not a function` before any token was stored.
 *
 * Covers: login persists both tokens, session restoration on reload, refresh
 * reads the stored refresh token and rotates it, and logout clears both keys.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import React, { useEffect } from "react";
import { render, waitFor, act } from "@testing-library/react";

const ACCESS_KEY = "tripjar_access_token";
const REFRESH_KEY = "tripjar_refresh_token";

// AsyncStorage is only used for the one-time legacy-token migration.
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async () => null),
    removeItem: vi.fn(async () => undefined),
  },
}));

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

// NOTE: @/lib/token-storage is deliberately NOT mocked — the real web adapter
// (localStorage) is exercised here.

import { AuthProvider, useAuth } from "../contexts/auth-context";

function makeJwt(expOffsetSec: number): string {
  const payload = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + expOffsetSec }));
  return `${btoa(JSON.stringify({ alg: "none" }))}.${payload}.sig`;
}

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

async function mount() {
  render(
    <AuthProvider>
      <Consumer />
    </AuthProvider>,
  );
  await waitFor(() => expect(authApi).not.toBeNull());
}

beforeEach(() => {
  window.localStorage.clear();
  capturedGetter = null;
  authApi = null;
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("login on web persists tokens", () => {
  it("stores both access and refresh tokens in localStorage", async () => {
    const access = makeJwt(900);
    vi.stubGlobal(
      "fetch",
      vi.fn(() => jsonResponse(200, { token: access, refreshToken: "refresh-1" })),
    );

    await mount();
    await act(async () => {
      await authApi!.login({ email: "jordan@dripjar.dev", password: "password123" } as never);
    });

    // The exact failure mode of the bug: nothing was ever written.
    expect(window.localStorage.getItem(ACCESS_KEY)).toBe(access);
    expect(window.localStorage.getItem(REFRESH_KEY)).toBe("refresh-1");
    expect(authApi!.token).toBe(access);
  });

  it("does not throw a native-module error during login", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => jsonResponse(200, { token: makeJwt(900), refreshToken: "refresh-1" })),
    );
    await mount();

    let thrown: unknown = null;
    await act(async () => {
      try {
        await authApi!.login({ email: "a@b.c", password: "x" } as never);
      } catch (e) {
        thrown = e;
      }
    });

    expect(thrown).toBeNull();
  });

  it("register persists tokens the same way", async () => {
    const access = makeJwt(900);
    vi.stubGlobal(
      "fetch",
      vi.fn(() => jsonResponse(201, { token: access, refreshToken: "refresh-reg" })),
    );

    await mount();
    await act(async () => {
      await authApi!.register({
        email: "new@dripjar.dev", password: "P@ssword1!", firstName: "New", lastName: "User",
      } as never);
    });

    expect(window.localStorage.getItem(ACCESS_KEY)).toBe(access);
    expect(window.localStorage.getItem(REFRESH_KEY)).toBe("refresh-reg");
  });
});

describe("session restoration on web", () => {
  it("restores a valid session from localStorage on mount (browser refresh)", async () => {
    const access = makeJwt(900);
    window.localStorage.setItem(ACCESS_KEY, access);
    window.localStorage.setItem(REFRESH_KEY, "refresh-persisted");

    await mount();

    await waitFor(() => expect(authApi!.isLoading).toBe(false));
    expect(authApi!.token).toBe(access);
  });

  it("refreshes on mount when the stored access token has expired", async () => {
    window.localStorage.setItem(ACCESS_KEY, makeJwt(-60));
    window.localStorage.setItem(REFRESH_KEY, "refresh-persisted");

    const fresh = makeJwt(900);
    const fetchMock = vi.fn((url: RequestInfo | URL) => {
      expect(String(url)).toContain("/api/auth/refresh");
      return jsonResponse(200, { token: fresh, refreshToken: "refresh-rotated" });
    });
    vi.stubGlobal("fetch", fetchMock);

    await mount();
    await waitFor(() => expect(authApi!.isLoading).toBe(false));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem(ACCESS_KEY)).toBe(fresh);
    expect(window.localStorage.getItem(REFRESH_KEY)).toBe("refresh-rotated");
  });
});

describe("refresh flow reads the stored refresh token", () => {
  it("sends the persisted refresh token and stores the rotated one", async () => {
    window.localStorage.setItem(ACCESS_KEY, makeJwt(-60));
    window.localStorage.setItem(REFRESH_KEY, "refresh-stored");

    const fresh = makeJwt(900);
    let sentBody: string | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
        sentBody = String(init?.body ?? "");
        return jsonResponse(200, { token: fresh, refreshToken: "refresh-rotated-2" });
      }),
    );

    await mount();
    await waitFor(() => expect(authApi!.isLoading).toBe(false));

    // The refresh token actually travelled from storage to the request.
    expect(sentBody).toContain("refresh-stored");
    // Rotation is persisted, so the old token is not reusable.
    expect(window.localStorage.getItem(REFRESH_KEY)).toBe("refresh-rotated-2");
  });
});

describe("logout on web clears tokens", () => {
  it("removes both keys from localStorage", async () => {
    const access = makeJwt(900);
    vi.stubGlobal(
      "fetch",
      vi.fn(() => jsonResponse(200, { token: access, refreshToken: "refresh-1" })),
    );

    await mount();
    await act(async () => {
      await authApi!.login({ email: "a@b.c", password: "x" } as never);
    });
    expect(window.localStorage.getItem(ACCESS_KEY)).toBe(access);

    vi.stubGlobal("fetch", vi.fn(() => jsonResponse(200, { ok: true })));
    await act(async () => {
      await authApi!.logout();
    });

    expect(window.localStorage.getItem(ACCESS_KEY)).toBeNull();
    expect(window.localStorage.getItem(REFRESH_KEY)).toBeNull();
    expect(authApi!.token).toBeNull();
  });

  it("clears local tokens even when the server logout call fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => jsonResponse(200, { token: makeJwt(900), refreshToken: "refresh-1" })),
    );
    await mount();
    await act(async () => {
      await authApi!.login({ email: "a@b.c", password: "x" } as never);
    });

    // Server unreachable — the session must still end locally.
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new TypeError("Network request failed"))));
    await act(async () => {
      await authApi!.logout();
    });

    expect(window.localStorage.getItem(ACCESS_KEY)).toBeNull();
    expect(window.localStorage.getItem(REFRESH_KEY)).toBeNull();
  });

  it("sends the stored refresh token to the logout endpoint (server-side revocation)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => jsonResponse(200, { token: makeJwt(900), refreshToken: "refresh-to-revoke" })),
    );
    await mount();
    await act(async () => {
      await authApi!.login({ email: "a@b.c", password: "x" } as never);
    });

    let logoutBody: string | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
        logoutBody = String(init?.body ?? "");
        return jsonResponse(200, { ok: true });
      }),
    );
    await act(async () => {
      await authApi!.logout();
    });

    expect(logoutBody).toContain("refresh-to-revoke");
  });
});
