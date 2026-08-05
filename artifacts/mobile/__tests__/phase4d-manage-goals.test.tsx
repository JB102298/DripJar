/**
 * Phase 4D — Manage Goals screen tests
 *
 * Renders app/jar/[id]/goals.tsx under jsdom via react-native-web with all
 * data hooks mocked.  Covers:
 *
 *   - Organizer sees goal list, management controls, and Add Goal button
 *   - Regular member sees goal list but NO management controls
 *   - Create goal: form renders, valid submission calls createGoal
 *   - Create goal: over-Jar-target 409 message surfaced
 *   - Edit goal: form pre-filled, updateGoal called with correct args
 *   - Server error surfaced in the form
 *   - Remove goal: confirmation shown, archiveGoal called, goals refetched
 *   - Reorder: Move Up / Move Down send complete ordered ID list
 *   - Financial planning display: jar target, allocated, unallocated, over-target
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React from "react";
import { render, fireEvent, waitFor, cleanup } from "@testing-library/react";

// ─── Expo-router ─────────────────────────────────────────────────────────────
vi.mock("expo-router", () => ({
  useLocalSearchParams: () => ({ id: "jar-1" }),
  useRouter: () => ({ back: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

// ─── Colors ───────────────────────────────────────────────────────────────────
vi.mock("@/hooks/useColors", () => ({
  useColors: () => ({
    background: "#F7FAF8",
    foreground: "#17211B",
    card: "#FFFFFF",
    primary: "#178B57",
    primaryForeground: "#FFFFFF",
    secondary: "#E8F6EF",
    secondaryForeground: "#0E5F3B",
    muted: "#E8F6EF",
    mutedForeground: "#657069",
    border: "#DDE7E1",
    destructive: "#C94B4B",
    destructiveForeground: "#FFFFFF",
    success: "#2E9D63",
    warning: "#D99A25",
    darkGreen: "#0E5F3B",
    lightGreen: "#E8F6EF",
    radius: 12,
  }),
}));

// ─── Safe area ────────────────────────────────────────────────────────────────
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// ─── Icons + components ───────────────────────────────────────────────────────
vi.mock("@expo/vector-icons", () => ({ Feather: () => null }));
vi.mock("@/components/ProgressBar", () => ({ ProgressBar: () => null }));
vi.mock("@/components/CurrencyInput", () => ({
  CurrencyInput: ({ value, onChangeCents, testID }: any) => (
    <input
      data-testid={testID}
      type="number"
      value={String(value ?? 0)}
      onChange={(e) => onChangeCents(Number(e.target.value))}
    />
  ),
}));

// ─── Goals data ───────────────────────────────────────────────────────────────

const goal1 = {
  id: "goal-a",
  name: "Wedding Venue",
  description: "Hall deposit",
  targetPrincipalCents: 300000,
  sortOrder: 1,
  status: "active" as const,
  savedAllocatedCents: 150000,
  committedAllocatedCents: 50000,
  savedPercent: 50,
  committedPercent: 17,
  fundingState: "partially_funded" as const,
};

const goal2 = {
  id: "goal-b",
  name: "Honeymoon Trip",
  description: null,
  targetPrincipalCents: 450000,
  sortOrder: 2,
  status: "active" as const,
  savedAllocatedCents: 0,
  committedAllocatedCents: 0,
  savedPercent: 0,
  committedPercent: 0,
  fundingState: "unfunded" as const,
};

const makeGoalsData = (isOrganizer = true, goals = [goal1, goal2]) => ({
  goals,
  isOrganizer,
  goalAmountCents: 1000000,
  savedPrincipalCents: 150000,
  committedPrincipalCents: 50000,
  unallocatedTargetCents: 250000, // 1000000 - 750000
  savedTowardUnallocatedCents: 0,
  overTargetCents: 0,
  // legacy aliases
  unallocatedCents: 250000,
  surplusCents: 0,
});

// Mutable refs for mock control
let mockGoalsData: ReturnType<typeof makeGoalsData> | undefined = makeGoalsData();
let mockRefetch = vi.fn();

vi.mock("@/hooks/useJarGoals", () => ({
  useJarGoals: () => ({ data: mockGoalsData, isLoading: false, refetch: mockRefetch }),
}));

// ─── Mutation stubs ───────────────────────────────────────────────────────────

const mockCreate = vi.fn(async () => ({ id: "goal-new", name: "New Goal" }));
const mockUpdate = vi.fn(async () => ({ id: "goal-a", name: "Updated" }));
const mockArchive = vi.fn(async () => ({ deleted: false, archived: true }));
const mockReorder = vi.fn(async () => ({ goals: [] }));
const mockClearError = vi.fn();

let mockSubmitting = false;
let mockError: string | null = null;

vi.mock("@/hooks/useGoalMutations", () => ({
  useGoalMutations: () => ({
    submitting: mockSubmitting,
    error: mockError,
    clearError: mockClearError,
    createGoal: mockCreate,
    updateGoal: mockUpdate,
    archiveGoal: mockArchive,
    reorderGoals: mockReorder,
  }),
}));

// ─── Screen under test ────────────────────────────────────────────────────────

import ManageGoalsScreen from "@/app/jar/[id]/goals";

// ─── Setup / teardown ─────────────────────────────────────────────────────────

let confirmSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  mockGoalsData = makeGoalsData();
  mockRefetch = vi.fn();
  mockSubmitting = false;
  mockError = null;
  vi.clearAllMocks();
  confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
});

afterEach(() => {
  cleanup();
  confirmSpy.mockRestore();
});

// ─────────────────────────────────────────────────────────────────────────────
// Manage route renders
// ─────────────────────────────────────────────────────────────────────────────

describe("Manage Goals route — renders", () => {
  it("mounts without error and shows the screen title", () => {
    const { getByText } = render(<ManageGoalsScreen />);
    expect(getByText("Manage Goals")).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Organizer vs member controls
// ─────────────────────────────────────────────────────────────────────────────

describe("Authorization — organizer controls", () => {
  it("organizer sees Add Goal button", () => {
    const { getByTestId } = render(<ManageGoalsScreen />);
    expect(getByTestId("add-goal-button")).toBeTruthy();
  });

  it("organizer sees edit and remove controls for each goal", () => {
    const { getByTestId } = render(<ManageGoalsScreen />);
    expect(getByTestId("goal-edit-goal-a")).toBeTruthy();
    expect(getByTestId("goal-remove-goal-a")).toBeTruthy();
    expect(getByTestId("goal-edit-goal-b")).toBeTruthy();
    expect(getByTestId("goal-remove-goal-b")).toBeTruthy();
  });

  it("organizer sees move-up and move-down controls for each goal", () => {
    const { getByTestId } = render(<ManageGoalsScreen />);
    expect(getByTestId("goal-move-up-goal-a")).toBeTruthy();
    expect(getByTestId("goal-move-down-goal-a")).toBeTruthy();
    expect(getByTestId("goal-move-up-goal-b")).toBeTruthy();
    expect(getByTestId("goal-move-down-goal-b")).toBeTruthy();
  });

  it("regular member does NOT see Add Goal button", () => {
    mockGoalsData = makeGoalsData(false);
    const { queryByTestId } = render(<ManageGoalsScreen />);
    expect(queryByTestId("add-goal-button")).toBeNull();
  });

  it("regular member does NOT see edit or remove controls", () => {
    mockGoalsData = makeGoalsData(false);
    const { queryByTestId } = render(<ManageGoalsScreen />);
    expect(queryByTestId("goal-edit-goal-a")).toBeNull();
    expect(queryByTestId("goal-remove-goal-a")).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Financial planning display
// ─────────────────────────────────────────────────────────────────────────────

describe("Financial planning display", () => {
  it("shows jar target in the summary card", () => {
    const { getByTestId } = render(<ManageGoalsScreen />);
    expect(getByTestId("summary-jar-target").textContent).toContain("10,000");
  });

  it("shows allocated named goal total in the summary card", () => {
    const { getByTestId } = render(<ManageGoalsScreen />);
    // goal1 + goal2 = $3,000 + $4,500 = $7,500
    expect(getByTestId("summary-allocated").textContent).toContain("7,500");
  });

  it("shows unallocated target in the summary card", () => {
    const { getByTestId } = render(<ManageGoalsScreen />);
    // $10,000 - $7,500 = $2,500
    expect(getByTestId("summary-unallocated").textContent).toContain("2,500");
  });

  it("over-target badge is NOT shown when savedPrincipal is below jar target", () => {
    const { queryByTestId } = render(<ManageGoalsScreen />);
    expect(queryByTestId("summary-over-target")).toBeNull();
  });

  it("over-target badge IS shown when savedPrincipal exceeds jar target", () => {
    mockGoalsData = { ...makeGoalsData(), overTargetCents: 50000 };
    const { getByTestId } = render(<ManageGoalsScreen />);
    expect(getByTestId("summary-over-target").textContent).toContain("500");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Goal list rendering
// ─────────────────────────────────────────────────────────────────────────────

describe("Goal list", () => {
  it("renders each active goal by name", () => {
    const { getByText } = render(<ManageGoalsScreen />);
    expect(getByText("Wedding Venue")).toBeTruthy();
    expect(getByText("Honeymoon Trip")).toBeTruthy();
  });

  it("each goal row has a testID", () => {
    const { getByTestId } = render(<ManageGoalsScreen />);
    expect(getByTestId("goal-item-goal-a")).toBeTruthy();
    expect(getByTestId("goal-item-goal-b")).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Create goal
// ─────────────────────────────────────────────────────────────────────────────

describe("Create goal", () => {
  it("tapping Add Goal opens the create form", async () => {
    const { getByTestId } = render(<ManageGoalsScreen />);
    fireEvent.click(getByTestId("add-goal-button"));
    expect(getByTestId("goal-name-input")).toBeTruthy();
    expect(getByTestId("goal-save-button")).toBeTruthy();
    expect(getByTestId("goal-cancel-button")).toBeTruthy();
  });

  it("submitting a valid goal calls createGoal and closes the modal", async () => {
    const { getByTestId, queryByTestId } = render(<ManageGoalsScreen />);
    fireEvent.click(getByTestId("add-goal-button"));

    fireEvent.change(getByTestId("goal-name-input"), { target: { value: "Flight Tickets" } });
    fireEvent.change(getByTestId("goal-target-input"), { target: { value: "200000" } });
    fireEvent.click(getByTestId("goal-save-button"));

    await waitFor(() => {
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({ name: "Flight Tickets", targetPrincipalCents: 200000 }),
      );
    });
    await waitFor(() => expect(mockRefetch).toHaveBeenCalled());
    // Modal closes after success
    await waitFor(() => expect(queryByTestId("goal-save-button")).toBeNull());
  });

  it("shows validation error when name is empty", async () => {
    const { getByTestId } = render(<ManageGoalsScreen />);
    fireEvent.click(getByTestId("add-goal-button"));
    // leave name empty
    fireEvent.change(getByTestId("goal-target-input"), { target: { value: "100000" } });
    fireEvent.click(getByTestId("goal-save-button"));

    await waitFor(() => {
      expect(getByTestId("goal-form-error").textContent).toMatch(/name is required/i);
    });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("shows validation error when target is zero", async () => {
    const { getByTestId } = render(<ManageGoalsScreen />);
    fireEvent.click(getByTestId("add-goal-button"));
    fireEvent.change(getByTestId("goal-name-input"), { target: { value: "My Goal" } });
    // leave target at 0
    fireEvent.click(getByTestId("goal-save-button"));

    await waitFor(() => {
      expect(getByTestId("goal-form-error").textContent).toMatch(/greater than zero/i);
    });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("surfaces a 409 server error message when named goals exceed jar target", async () => {
    const serverMsg =
      "Your named goals can't total more than the Jar target.";
    mockCreate.mockRejectedValueOnce(new Error(serverMsg));

    const { getByTestId } = render(<ManageGoalsScreen />);
    fireEvent.click(getByTestId("add-goal-button"));
    fireEvent.change(getByTestId("goal-name-input"), { target: { value: "Overflow Goal" } });
    fireEvent.change(getByTestId("goal-target-input"), { target: { value: "999999" } });
    fireEvent.click(getByTestId("goal-save-button"));

    await waitFor(() => {
      expect(getByTestId("goal-form-error").textContent).toContain(
        "named goals can't total more than",
      );
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Edit goal
// ─────────────────────────────────────────────────────────────────────────────

describe("Edit goal", () => {
  it("tapping edit pre-fills the form with existing values", async () => {
    const { getByTestId } = render(<ManageGoalsScreen />);
    fireEvent.click(getByTestId("goal-edit-goal-a"));

    await waitFor(() => {
      const nameInput = getByTestId("goal-name-input") as HTMLInputElement;
      expect(nameInput.value).toBe("Wedding Venue");
    });
  });

  it("saving an edit calls updateGoal with the correct goalId", async () => {
    const { getByTestId } = render(<ManageGoalsScreen />);
    fireEvent.click(getByTestId("goal-edit-goal-a"));

    await waitFor(() => getByTestId("goal-name-input"));
    fireEvent.change(getByTestId("goal-name-input"), { target: { value: "Venue Updated" } });
    fireEvent.click(getByTestId("goal-save-button"));

    await waitFor(() => {
      expect(mockUpdate).toHaveBeenCalledWith(
        "goal-a",
        expect.objectContaining({ name: "Venue Updated" }),
      );
    });
    await waitFor(() => expect(mockRefetch).toHaveBeenCalled());
  });

  it("updating description passes new description to updateGoal", async () => {
    const { getByTestId } = render(<ManageGoalsScreen />);
    fireEvent.click(getByTestId("goal-edit-goal-a"));

    await waitFor(() => getByTestId("goal-description-input"));
    fireEvent.change(getByTestId("goal-description-input"), { target: { value: "New desc" } });
    fireEvent.change(getByTestId("goal-name-input"), { target: { value: "Wedding Venue" } });
    fireEvent.click(getByTestId("goal-save-button"));

    await waitFor(() => {
      expect(mockUpdate).toHaveBeenCalledWith(
        "goal-a",
        expect.objectContaining({ description: "New desc" }),
      );
    });
  });

  it("surfaces server error in the form on update failure", async () => {
    mockUpdate.mockRejectedValueOnce(new Error("Server rejected the change"));
    // Simulate the hook setting error state
    mockError = "Server rejected the change";

    const { getByTestId } = render(<ManageGoalsScreen />);
    fireEvent.click(getByTestId("goal-edit-goal-a"));

    await waitFor(() => getByTestId("goal-form-error"));
    expect(getByTestId("goal-form-error").textContent).toContain("Server rejected");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Remove goal
// ─────────────────────────────────────────────────────────────────────────────

describe("Remove goal", () => {
  it("tapping remove shows a confirmation dialog", () => {
    const { getByTestId } = render(<ManageGoalsScreen />);
    fireEvent.click(getByTestId("goal-remove-goal-a"));
    expect(confirmSpy).toHaveBeenCalled();
  });

  it("confirming removal calls archiveGoal and refetches", async () => {
    confirmSpy.mockReturnValue(true);
    const { getByTestId } = render(<ManageGoalsScreen />);
    fireEvent.click(getByTestId("goal-remove-goal-a"));

    await waitFor(() => expect(mockArchive).toHaveBeenCalledWith("goal-a"));
    await waitFor(() => expect(mockRefetch).toHaveBeenCalled());
  });

  it("declining removal does not call archiveGoal", () => {
    confirmSpy.mockReturnValue(false);
    const { getByTestId } = render(<ManageGoalsScreen />);
    fireEvent.click(getByTestId("goal-remove-goal-a"));
    expect(mockArchive).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Reorder goals
// ─────────────────────────────────────────────────────────────────────────────

describe("Reorder goals", () => {
  it("Move Down on goal-a sends [goal-b, goal-a] to reorderGoals", async () => {
    const { getByTestId } = render(<ManageGoalsScreen />);
    fireEvent.click(getByTestId("goal-move-down-goal-a"));

    await waitFor(() => {
      expect(mockReorder).toHaveBeenCalledWith(["goal-b", "goal-a"]);
    });
  });

  it("Move Up on goal-b sends [goal-b, goal-a] to reorderGoals", async () => {
    const { getByTestId } = render(<ManageGoalsScreen />);
    fireEvent.click(getByTestId("goal-move-up-goal-b"));

    await waitFor(() => {
      expect(mockReorder).toHaveBeenCalledWith(["goal-b", "goal-a"]);
    });
  });

  it("sends the complete ordered list of active goal IDs", async () => {
    const { getByTestId } = render(<ManageGoalsScreen />);
    fireEvent.click(getByTestId("goal-move-down-goal-a"));

    // Both goal-a and goal-b must be in the reorder call (no omissions)
    await waitFor(() => {
      expect(mockReorder).toHaveBeenCalledWith(
        expect.arrayContaining(["goal-a", "goal-b"]),
      );
    });
    // Exactly 2 IDs — no extras added
    const calledWith = mockReorder.mock.calls.find((call) => Array.isArray(call[0]));
    expect(calledWith![0]).toHaveLength(2);
  });

  it("refetches goals after a successful reorder to reflect canonical server order", async () => {
    const { getByTestId } = render(<ManageGoalsScreen />);
    fireEvent.click(getByTestId("goal-move-down-goal-a"));

    await waitFor(() => expect(mockReorder).toHaveBeenCalled());
    await waitFor(() => expect(mockRefetch).toHaveBeenCalled());
  });
});
