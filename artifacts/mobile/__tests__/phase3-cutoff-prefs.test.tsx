/**
 * Phase 3 Mobile Tests — Email notification preferences
 *
 * Verifies that the profile screen renders the three email preference
 * toggles (Contribution Reminders, Cutoff Reminders, Lifecycle Notifications)
 * introduced in Phase 3.
 *
 * API-side coverage (cutoff date model, commitment phase, schedule status,
 * reminder idempotency) lives in the API test suite.
 *
 * Note: the Commitment Date (cutoff) field added to `create-jar/dates.tsx`
 * cannot be rendered in this test environment because that screen depends on
 * `@react-native-community/datetimepicker`, which is a native module that
 * esbuild cannot process in jsdom mode. Cutoff-date field correctness is
 * instead verified by inspecting the source and by the API test suite.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import React from "react";
import { render, cleanup } from "@testing-library/react";

// ─── Expo-router ──────────────────────────────────────────────────────────────
vi.mock("expo-router", () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), replace: vi.fn() }),
}));

// ─── Safe-area ────────────────────────────────────────────────────────────────
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// ─── Colors ───────────────────────────────────────────────────────────────────
vi.mock("@/hooks/useColors", () => ({
  useColors: () => new Proxy({}, { get: () => "#000000" }),
}));

// ─── Feather icons ────────────────────────────────────────────────────────────
vi.mock("@expo/vector-icons", () => ({ Feather: () => null }));

// ─── API client ───────────────────────────────────────────────────────────────
vi.mock("@workspace/api-client-react", () => ({
  useGetDashboard: () => ({
    data: { totalJars: 2, personalProgress: { contributedAmountCents: 0 } },
  }),
  useSendVerification: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useGetAuthPreferences: () => ({
    data: {
      emailPrefContributionReminders: true,
      emailPrefCutoffReminders: false,
      emailPrefLifecycle: true,
    },
  }),
  useUpdateAuthPreferences: () => ({ mutateAsync: vi.fn() }),
}));

// ─── Auth context ─────────────────────────────────────────────────────────────
vi.mock("@/contexts/auth-context", () => ({
  useAuth: () => ({
    profile: { displayName: "Jordan", firstName: "Jordan", lastName: "T", avatarUrl: null },
    user: { email: "jordan@test.com", emailVerified: true, id: "u1" },
    logout: vi.fn(),
  }),
}));

// ─── Misc components ─────────────────────────────────────────────────────────
vi.mock("@/components/MemberAvatar", () => ({ MemberAvatar: () => null }));

// ─── Static import (must be after all vi.mock calls) ─────────────────────────
import ProfileScreen from "../app/(tabs)/profile";

afterEach(() => cleanup());

// ─────────────────────────────────────────────────────────────────────────────
// Profile screen — email notification preference toggles
// ─────────────────────────────────────────────────────────────────────────────

describe("Profile screen — email notification preferences (Phase 3)", () => {
  it("renders the Notifications section header", () => {
    const { getByText } = render(<ProfileScreen />);
    expect(getByText("Notifications")).toBeTruthy();
  });

  it("renders the Contribution Reminders row label", () => {
    const { getByText } = render(<ProfileScreen />);
    expect(getByText("Contribution Reminders")).toBeTruthy();
  });

  it("renders the Cutoff Reminders row label", () => {
    const { getByText } = render(<ProfileScreen />);
    expect(getByText("Cutoff Reminders")).toBeTruthy();
  });

  it("renders the Lifecycle Notifications row label", () => {
    const { getByText } = render(<ProfileScreen />);
    expect(getByText("Lifecycle Notifications")).toBeTruthy();
  });

  it("renders subtitle text for Contribution Reminders", () => {
    const { getByText } = render(<ProfileScreen />);
    expect(getByText("Due & missed contribution alerts")).toBeTruthy();
  });

  it("renders subtitle text for Cutoff Reminders", () => {
    const { getByText } = render(<ProfileScreen />);
    expect(getByText("Approaching commitment phase")).toBeTruthy();
  });

  it("renders subtitle text for Lifecycle Notifications", () => {
    const { getByText } = render(<ProfileScreen />);
    expect(getByText("Jar status changes & milestones")).toBeTruthy();
  });
});
