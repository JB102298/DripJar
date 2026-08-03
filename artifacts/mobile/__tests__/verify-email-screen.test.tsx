/**
 * Phase 2: verify-email screen behavior tests.
 *
 * Renders the real app/verify-email/[token].tsx screen under jsdom via
 * react-native-web with expo-router, the API hook, auth context, and
 * theming mocked (same pattern as reset-password-screen.test.tsx).
 *
 * Covers:
 *  - auto-verifies on mount with the URL token (called exactly once)
 *  - success state + continue routing (authed → tabs, guest → login)
 *  - invalid/expired token shows the error state
 *  - missing token shows the error state without calling the API
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React from "react";
import { render, waitFor, fireEvent, cleanup } from "@testing-library/react";

// ─── Mocks ───────────────────────────────────────────────────────────────────

const mockReplace = vi.fn();
let mockToken: string | undefined = "raw-verify-token-abc";
let mockIsAuthenticated = false;

vi.mock("expo-router", () => ({
  useLocalSearchParams: () => ({ token: mockToken }),
  useRouter: () => ({ replace: mockReplace, push: vi.fn(), back: vi.fn() }),
}));

const mutateAsync = vi.fn();
vi.mock("@workspace/api-client-react", () => ({
  useVerifyEmail: () => ({ mutateAsync }),
}));

vi.mock("@/contexts/auth-context", () => ({
  useAuth: () => ({ isAuthenticated: mockIsAuthenticated }),
}));

vi.mock("@/hooks/useColors", () => ({
  useColors: () => new Proxy({}, { get: () => "#000000" }),
}));

vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock("@expo/vector-icons", () => ({
  Feather: () => null,
}));

import VerifyEmailScreen from "../app/verify-email/[token]";

beforeEach(() => {
  mutateAsync.mockReset();
  mockReplace.mockReset();
  mockToken = "raw-verify-token-abc";
  mockIsAuthenticated = false;
});

afterEach(() => {
  cleanup();
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("VerifyEmailScreen", () => {
  it("verifies the token on mount exactly once and shows success", async () => {
    mutateAsync.mockResolvedValueOnce({});
    const { findByTestId } = render(<VerifyEmailScreen />);
    await findByTestId("verify-success");
    expect(mutateAsync).toHaveBeenCalledTimes(1);
    expect(mutateAsync).toHaveBeenCalledWith({ data: { token: "raw-verify-token-abc" } });
  });

  it("guest continue routes to login", async () => {
    mutateAsync.mockResolvedValueOnce({});
    const { findByTestId } = render(<VerifyEmailScreen />);
    fireEvent.click(await findByTestId("verify-continue"));
    expect(mockReplace).toHaveBeenCalledWith("/(auth)/login");
  });

  it("authenticated continue routes to the app tabs", async () => {
    mockIsAuthenticated = true;
    mutateAsync.mockResolvedValueOnce({});
    const { findByTestId } = render(<VerifyEmailScreen />);
    fireEvent.click(await findByTestId("verify-continue"));
    expect(mockReplace).toHaveBeenCalledWith("/(tabs)");
  });

  it("shows the error state for an invalid/expired token", async () => {
    mutateAsync.mockRejectedValueOnce({ status: 400 });
    const { findByTestId } = render(<VerifyEmailScreen />);
    const error = await findByTestId("verify-error");
    expect(error.textContent).toMatch(/invalid or has expired/i);
  });

  it("shows the error state without an API call when the token is missing", async () => {
    mockToken = undefined;
    const { findByTestId } = render(<VerifyEmailScreen />);
    await findByTestId("verify-error");
    expect(mutateAsync).not.toHaveBeenCalled();
  });
});
