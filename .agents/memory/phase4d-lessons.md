---
name: Phase 4D lessons
description: Lessons from Phase 4D (mobile goal management) — RN Modal DOM retention in jsdom, useGoalMutations hook pattern, terminal status guard, vi.mock for useQuery hooks
---

## React Native Modal in jsdom/react-native-web retains children

When `visible={false}`, RN's Modal component in react-native-web keeps children in the DOM (hidden via CSS for animation). `queryByTestId("...")` still returns the element. Test assertions like `expect(queryByTestId("save-btn")).toBeNull()` always fail.

**Why:** RN Modal uses portals with CSS visibility; the portal is not unmounted on `visible=false`.

**How to apply:** For any screen that needs to test "modal closed" state, replace `<Modal visible={...}>` with a plain conditional render `{condition && <View>...</View>}`. This guarantees the children are truly absent from the VDOM.

## useGoalMutations — plain useState/useCallback pattern (no useMutation)

Goal mutations use `customFetch` + `useState`/`useCallback` rather than `@tanstack/react-query`'s `useMutation`. This matches the commitment screen and avoids the QueryClientProvider requirement that breaks tests.

**Why:** Tests render without a QueryClientProvider. `useMutation` calls `useQueryClient()` which throws outside the provider.

**How to apply:** Any new mutation hook in the mobile app should follow the same pattern unless a QueryClientProvider is explicitly added to the test setup.

## Terminal status guard pattern

All goal mutation endpoints (create, update, archive, reorder) use a shared `TERMINAL_STATUSES = ["Cancelled", "Completed"]` constant and `isTerminal()` helper. The guard is checked inside the DB transaction after verifying jar existence and organizer permission.

**Why:** Prevents mutation of goals in jars that are already closed/settled.

**How to apply:** Any future mutation route that touches jar-owned resources should apply the same guard before proceeding.

## vi.mock for useQuery-based hooks in mobile tests

When a component uses a hook that calls `useQuery` (e.g. `useJarGoals`, `useFinancialSummary`), every test file that renders that component must mock the hook. The mock should return `{ data: undefined, isLoading: false, refetch: vi.fn() }`.

**Why:** react-testing-library renders the real component which calls the real hook. `useQuery` requires a `QueryClientProvider`; without one it throws during render, breaking all tests in that file.

**How to apply:** When adding a `useQuery`-based hook to any screen, immediately add `vi.mock(...)` to every existing test file that renders that screen.
