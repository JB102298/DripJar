/**
 * Token storage adapter tests.
 *
 * Regression guard for the web login failure:
 *   `ExpoSecureStore.default.setValueWithKeyAsync is not a function`
 *
 * expo-secure-store is native-only; calling it from the browser threw at the
 * first `setItem` during login. auth-context now depends on the
 * `@/lib/token-storage` seam, which Metro resolves per platform.
 *
 * This suite runs under jsdom, so `@/lib/token-storage` resolves to the web
 * implementation — the same code the browser bundle uses. The native adapter's
 * contract is verified separately against a mocked expo-secure-store.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const ACCESS_KEY = "tripjar_access_token";
const REFRESH_KEY = "tripjar_refresh_token";

// ─── Web implementation ───────────────────────────────────────────────────────

describe("token-storage (web) — set/get/delete", () => {
  beforeEach(async () => {
    window.localStorage.clear();
    const mod = await import("../lib/token-storage.web");
    mod.__memoryFallback.clear();
  });

  it("uses localStorage as its backend", async () => {
    const { storageBackend } = await import("../lib/token-storage.web");
    expect(storageBackend).toBe("localStorage");
  });

  it("returns null for a key that was never set", async () => {
    const { getItem } = await import("../lib/token-storage.web");
    expect(await getItem(ACCESS_KEY)).toBeNull();
  });

  it("round-trips a value through set → get", async () => {
    const { setItem, getItem } = await import("../lib/token-storage.web");
    await setItem(ACCESS_KEY, "token-abc");
    expect(await getItem(ACCESS_KEY)).toBe("token-abc");
  });

  it("persists to localStorage so a page reload restores the session", async () => {
    const { setItem } = await import("../lib/token-storage.web");
    await setItem(REFRESH_KEY, "refresh-xyz");
    // Read through the raw browser API — proves it survives a reload rather
    // than living only in module memory.
    expect(window.localStorage.getItem(REFRESH_KEY)).toBe("refresh-xyz");
  });

  it("overwrites an existing value (refresh-token rotation)", async () => {
    const { setItem, getItem } = await import("../lib/token-storage.web");
    await setItem(REFRESH_KEY, "refresh-old");
    await setItem(REFRESH_KEY, "refresh-new");
    expect(await getItem(REFRESH_KEY)).toBe("refresh-new");
  });

  it("deletes a value", async () => {
    const { setItem, getItem, deleteItem } = await import("../lib/token-storage.web");
    await setItem(ACCESS_KEY, "token-abc");
    await deleteItem(ACCESS_KEY);
    expect(await getItem(ACCESS_KEY)).toBeNull();
    expect(window.localStorage.getItem(ACCESS_KEY)).toBeNull();
  });

  it("deleting an absent key resolves without throwing", async () => {
    const { deleteItem } = await import("../lib/token-storage.web");
    await expect(deleteItem("never-set")).resolves.toBeUndefined();
  });

  it("keeps keys independent", async () => {
    const { setItem, getItem, deleteItem } = await import("../lib/token-storage.web");
    await setItem(ACCESS_KEY, "a");
    await setItem(REFRESH_KEY, "r");
    await deleteItem(ACCESS_KEY);
    expect(await getItem(ACCESS_KEY)).toBeNull();
    expect(await getItem(REFRESH_KEY)).toBe("r");
  });

  it("never calls a native SecureStore API", async () => {
    // The original bug: expo-secure-store's web shim exposes no working
    // methods, so any call threw. The web adapter must not reference it.
    const source = await import("../lib/token-storage.web");
    expect(Object.keys(source)).not.toContain("setValueWithKeyAsync");
    expect(source.storageBackend).not.toBe("expo-secure-store");
  });
});

// ─── Web implementation — storage unavailable ────────────────────────────────

describe("token-storage (web) — localStorage unavailable", () => {
  const realLocalStorage = Object.getOwnPropertyDescriptor(window, "localStorage");

  afterEach(() => {
    if (realLocalStorage) Object.defineProperty(window, "localStorage", realLocalStorage);
    vi.restoreAllMocks();
  });

  it("falls back to memory when localStorage throws (private browsing)", async () => {
    vi.resetModules();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new Error("SecurityError: storage is disabled");
      },
    });

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { setItem, getItem, deleteItem } = await import("../lib/token-storage.web");

    await setItem(ACCESS_KEY, "fallback-token");
    expect(await getItem(ACCESS_KEY)).toBe("fallback-token");
    await deleteItem(ACCESS_KEY);
    expect(await getItem(ACCESS_KEY)).toBeNull();

    // A warning is fine; leaking the token value is not.
    for (const call of warn.mock.calls) {
      expect(String(call.join(" "))).not.toContain("fallback-token");
    }
  });
});

// ─── Native adapter contract ─────────────────────────────────────────────────

describe("token-storage (native) — delegates to expo-secure-store", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("maps get/set/delete onto the SecureStore async API with keys unchanged", async () => {
    const store = new Map<string, string>();
    const getItemAsync = vi.fn(async (k: string) => store.get(k) ?? null);
    const setItemAsync = vi.fn(async (k: string, v: string) => void store.set(k, v));
    const deleteItemAsync = vi.fn(async (k: string) => void store.delete(k));

    vi.doMock("expo-secure-store", () => ({ getItemAsync, setItemAsync, deleteItemAsync }));

    const native = await import("../lib/token-storage.native");

    expect(native.storageBackend).toBe("expo-secure-store");

    await native.setItem(ACCESS_KEY, "native-token");
    expect(setItemAsync).toHaveBeenCalledWith(ACCESS_KEY, "native-token");

    expect(await native.getItem(ACCESS_KEY)).toBe("native-token");
    expect(getItemAsync).toHaveBeenCalledWith(ACCESS_KEY);

    await native.deleteItem(ACCESS_KEY);
    expect(deleteItemAsync).toHaveBeenCalledWith(ACCESS_KEY);
    expect(await native.getItem(ACCESS_KEY)).toBeNull();

    vi.doUnmock("expo-secure-store");
  });

  it("exposes the same function surface as the web adapter", async () => {
    vi.doMock("expo-secure-store", () => ({
      getItemAsync: vi.fn(),
      setItemAsync: vi.fn(),
      deleteItemAsync: vi.fn(),
    }));

    const native = await import("../lib/token-storage.native");
    const web = await import("../lib/token-storage.web");

    // Both platforms must satisfy the interface auth-context depends on.
    for (const fn of ["getItem", "setItem", "deleteItem"] as const) {
      expect(typeof native[fn], `native.${fn}`).toBe("function");
      expect(typeof web[fn], `web.${fn}`).toBe("function");
    }

    vi.doUnmock("expo-secure-store");
  });
});
