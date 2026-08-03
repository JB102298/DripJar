/**
 * Phase 3A: reset-password screen behavior tests.
 *
 * Renders the real app/reset-password/[token].tsx screen under jsdom via
 * react-native-web with expo-router, the API hook, and theming mocked.
 *
 * Covers:
 *  - client-side password mismatch validation (no API call)
 *  - password policy minimum length (mirrors backend: 8 chars)
 *  - invalid/expired token API error (400) shows clear message, never the token
 *  - success path shows confirmation and a way back to login
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React from "react";
import { render, fireEvent, waitFor, cleanup } from "@testing-library/react";

// ─── Mocks ───────────────────────────────────────────────────────────────────

const mockReplace = vi.fn();
let mockToken: string | undefined = "raw-reset-token-abc";

vi.mock("expo-router", () => ({
  useLocalSearchParams: () => ({ token: mockToken }),
  useRouter: () => ({ replace: mockReplace, push: vi.fn(), back: vi.fn() }),
}));

const mutateAsync = vi.fn();
let isPending = false;
vi.mock("@workspace/api-client-react", () => ({
  useResetPassword: () => ({ mutateAsync, isPending }),
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

import ResetPasswordScreen from "../app/reset-password/[token]";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function setup() {
  const utils = render(<ResetPasswordScreen />);
  const password = utils.getByTestId("password-input");
  const confirm = utils.getByTestId("confirm-password-input");
  const submit = utils.getByTestId("submit-reset");
  return { ...utils, password, confirm, submit };
}

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  mutateAsync.mockReset();
  mockReplace.mockReset();
  mockToken = "raw-reset-token-abc";
  isPending = false;
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("ResetPasswordScreen", () => {
  it("shows a mismatch error and does not call the API when passwords differ", async () => {
    const { password, confirm, submit, getByTestId } = setup();

    fireEvent.change(password, { target: { value: "newpassword1" } });
    fireEvent.change(confirm, { target: { value: "different1" } });
    fireEvent.click(submit);

    await waitFor(() => {
      expect(getByTestId("reset-error").textContent).toMatch(/do not match/i);
    });
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it("enforces the backend minimum password length client-side", async () => {
    const { password, confirm, submit, getByTestId } = setup();

    fireEvent.change(password, { target: { value: "short" } });
    fireEvent.change(confirm, { target: { value: "short" } });
    fireEvent.click(submit);

    await waitFor(() => {
      expect(getByTestId("reset-error").textContent).toMatch(/at least 8 characters/i);
    });
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it("shows invalid/expired message on API 400 without echoing the token", async () => {
    mutateAsync.mockRejectedValue({ response: { status: 400 } });
    const { password, confirm, submit, getByTestId } = setup();

    fireEvent.change(password, { target: { value: "newpassword1" } });
    fireEvent.change(confirm, { target: { value: "newpassword1" } });
    fireEvent.click(submit);

    await waitFor(() => {
      const msg = getByTestId("reset-error").textContent ?? "";
      expect(msg).toMatch(/invalid or has expired/i);
      expect(msg).not.toContain("raw-reset-token-abc");
    });
    expect(mutateAsync).toHaveBeenCalledWith({
      data: { token: "raw-reset-token-abc", password: "newpassword1" },
    });
  });

  it("success path shows confirmation and navigates back to login", async () => {
    mutateAsync.mockResolvedValue({ message: "ok" });
    const { password, confirm, submit, getByTestId } = setup();

    fireEvent.change(password, { target: { value: "newpassword1" } });
    fireEvent.change(confirm, { target: { value: "newpassword1" } });
    fireEvent.click(submit);

    await waitFor(() => {
      expect(getByTestId("reset-success")).toBeTruthy();
    });

    fireEvent.click(getByTestId("go-to-login"));
    expect(mockReplace).toHaveBeenCalledWith("/(auth)/login");
  });

  it("missing token shows an invalid-link error without calling the API", async () => {
    mockToken = undefined;
    const { password, confirm, submit, getByTestId } = setup();

    fireEvent.change(password, { target: { value: "newpassword1" } });
    fireEvent.change(confirm, { target: { value: "newpassword1" } });
    fireEvent.click(submit);

    await waitFor(() => {
      expect(getByTestId("reset-error").textContent).toMatch(/invalid/i);
    });
    expect(mutateAsync).not.toHaveBeenCalled();
  });
});
