/**
 * Phase 2: change-password screen behavior tests.
 *
 * Renders the real app/change-password.tsx screen under jsdom via
 * react-native-web with expo-router, the API hook, auth context, and
 * theming mocked (same pattern as reset-password-screen.test.tsx).
 *
 * Covers:
 *  - client-side validation (missing current, mismatch, min length, same password)
 *  - wrong current password (401) shows a clear message
 *  - success path shows confirmation, and "Go to Sign In" logs out
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React from "react";
import { render, fireEvent, waitFor, cleanup } from "@testing-library/react";

// ─── Mocks ───────────────────────────────────────────────────────────────────

const mockReplace = vi.fn();
const mockBack = vi.fn();

vi.mock("expo-router", () => ({
  useRouter: () => ({ replace: mockReplace, push: vi.fn(), back: mockBack }),
}));

const mutateAsync = vi.fn();
vi.mock("@workspace/api-client-react", () => ({
  useChangePassword: () => ({ mutateAsync, isPending: false }),
}));

const mockLogout = vi.fn(async () => undefined);
vi.mock("@/contexts/auth-context", () => ({
  useAuth: () => ({ logout: mockLogout, user: { id: "u1" } }),
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

import ChangePasswordScreen from "../app/change-password";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function setup() {
  const utils = render(<ChangePasswordScreen />);
  const current = utils.getByTestId("current-password-input");
  const next = utils.getByTestId("new-password-input");
  const confirm = utils.getByTestId("confirm-password-input");
  const submit = utils.getByTestId("submit-change");
  return { ...utils, current, next, confirm, submit };
}

beforeEach(() => {
  mutateAsync.mockReset();
  mockReplace.mockReset();
  mockLogout.mockClear();
});

afterEach(() => {
  cleanup();
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("ChangePasswordScreen", () => {
  it("requires the current password before calling the API", async () => {
    const { next, confirm, submit, findByTestId } = setup();
    fireEvent.change(next, { target: { value: "newpassword1" } });
    fireEvent.change(confirm, { target: { value: "newpassword1" } });
    fireEvent.click(submit);
    const err = await findByTestId("change-error");
    expect(err.textContent).toMatch(/current password/i);
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it("enforces minimum length client-side", async () => {
    const { current, next, confirm, submit, findByTestId } = setup();
    fireEvent.change(current, { target: { value: "oldpassword1" } });
    fireEvent.change(next, { target: { value: "short" } });
    fireEvent.change(confirm, { target: { value: "short" } });
    fireEvent.click(submit);
    const err = await findByTestId("change-error");
    expect(err.textContent).toMatch(/at least 8/i);
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it("rejects mismatched confirmation client-side", async () => {
    const { current, next, confirm, submit, findByTestId } = setup();
    fireEvent.change(current, { target: { value: "oldpassword1" } });
    fireEvent.change(next, { target: { value: "newpassword1" } });
    fireEvent.change(confirm, { target: { value: "different1" } });
    fireEvent.click(submit);
    const err = await findByTestId("change-error");
    expect(err.textContent).toMatch(/do not match/i);
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it("rejects a new password equal to the current one client-side", async () => {
    const { current, next, confirm, submit, findByTestId } = setup();
    fireEvent.change(current, { target: { value: "samepassword1" } });
    fireEvent.change(next, { target: { value: "samepassword1" } });
    fireEvent.change(confirm, { target: { value: "samepassword1" } });
    fireEvent.click(submit);
    const err = await findByTestId("change-error");
    expect(err.textContent).toMatch(/different/i);
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it("shows a clear message when the current password is wrong (401)", async () => {
    mutateAsync.mockRejectedValueOnce({ status: 401 });
    const { current, next, confirm, submit, findByTestId } = setup();
    fireEvent.change(current, { target: { value: "wrongpassword" } });
    fireEvent.change(next, { target: { value: "newpassword1" } });
    fireEvent.change(confirm, { target: { value: "newpassword1" } });
    fireEvent.click(submit);
    const err = await findByTestId("change-error");
    expect(err.textContent).toMatch(/current password is incorrect/i);
  });

  it("on success shows confirmation, and Go to Sign In logs out and routes to login", async () => {
    mutateAsync.mockResolvedValueOnce({});
    const { current, next, confirm, submit, findByTestId } = setup();
    fireEvent.change(current, { target: { value: "oldpassword1" } });
    fireEvent.change(next, { target: { value: "newpassword1" } });
    fireEvent.change(confirm, { target: { value: "newpassword1" } });
    fireEvent.click(submit);

    await findByTestId("change-success");
    expect(mutateAsync).toHaveBeenCalledWith({
      data: { currentPassword: "oldpassword1", newPassword: "newpassword1" },
    });

    fireEvent.click(await findByTestId("go-to-login"));
    await waitFor(() => expect(mockLogout).toHaveBeenCalled());
    expect(mockReplace).toHaveBeenCalledWith("/(auth)/login");
  });
});
