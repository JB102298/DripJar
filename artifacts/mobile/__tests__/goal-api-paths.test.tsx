/**
 * Goals & Financial Summary — request path regression tests
 *
 * Owner QA found Goals and Financial Summary returning 404 in the running app.
 * Root cause: these hooks called `customFetch` with paths missing the `/api`
 * prefix that every route is mounted under. The hooks were otherwise correct —
 * right method, right body, right response handling — so type checking and the
 * existing screen tests (which mock the hooks wholesale) all passed.
 *
 * These tests assert the exact URL each operation requests, so the prefix is
 * covered by behaviour and not only by the source scan in
 * api-path-convention.test.ts. The two are complementary: this file proves the
 * six operations Owner QA exercised hit real routes; the scan covers every
 * other call site, including native-only screens jsdom cannot render.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import React from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// ─── customFetch mock ────────────────────────────────────────────────────────
//
// Resolves to an empty object: these tests assert the request, not the parsed
// response. Each hook's response shape is covered by its own screen tests.

// Parameters are declared so `mock.calls` is typed as [string, RequestInit?]
// rather than an empty tuple, which lets the assertions below index it.
const { customFetch } = vi.hoisted(() => ({
  customFetch: vi.fn(async (_url: string, _init?: RequestInit): Promise<unknown> => ({})),
}));

vi.mock("@workspace/api-client-react", () => ({ customFetch }));

import { useGoalMutations } from "../hooks/useGoalMutations";
import { useJarGoals } from "../hooks/useJarGoals";
import { useFinancialSummary } from "../hooks/useFinancialSummary";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const JAR_ID = "jar-abc";
const GOAL_ID = "goal-xyz";

/** Retry disabled so a rejected query surfaces immediately instead of backing off. */
function wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/** The URL passed to the single customFetch call recorded so far. */
function requestedUrl(): string {
  expect(customFetch).toHaveBeenCalledTimes(1);
  return customFetch.mock.calls[0][0];
}

function requestedInit(): RequestInit {
  return customFetch.mock.calls[0][1] ?? {};
}

beforeEach(() => {
  customFetch.mockClear();
});

// ─── Queries ─────────────────────────────────────────────────────────────────

describe("read paths", () => {
  it("useJarGoals fetches /api/jars/:jarId/goals", async () => {
    renderHook(() => useJarGoals(JAR_ID), { wrapper });

    await waitFor(() => expect(customFetch).toHaveBeenCalled());
    expect(requestedUrl()).toBe(`/api/jars/${JAR_ID}/goals`);
  });

  it("useFinancialSummary fetches /api/jars/:jarId/financial-summary", async () => {
    renderHook(() => useFinancialSummary(JAR_ID), { wrapper });

    await waitFor(() => expect(customFetch).toHaveBeenCalled());
    expect(requestedUrl()).toBe(`/api/jars/${JAR_ID}/financial-summary`);
  });

  it("does not fetch until a jar id is available", () => {
    renderHook(() => useJarGoals(undefined), { wrapper });
    expect(customFetch).not.toHaveBeenCalled();
  });
});

// ─── Mutations ───────────────────────────────────────────────────────────────

describe("goal mutation paths", () => {
  it("createGoal POSTs to /api/jars/:jarId/goals", async () => {
    const { result } = renderHook(() => useGoalMutations(JAR_ID));

    await result.current.createGoal({ name: "Flights", targetPrincipalCents: 250_000 });

    expect(requestedUrl()).toBe(`/api/jars/${JAR_ID}/goals`);
    expect(requestedInit().method).toBe("POST");
    expect(JSON.parse(requestedInit().body as string)).toEqual({
      name: "Flights",
      targetPrincipalCents: 250_000,
    });
  });

  it("updateGoal PATCHes /api/jars/:jarId/goals/:goalId", async () => {
    const { result } = renderHook(() => useGoalMutations(JAR_ID));

    await result.current.updateGoal(GOAL_ID, { name: "Lodging" });

    expect(requestedUrl()).toBe(`/api/jars/${JAR_ID}/goals/${GOAL_ID}`);
    expect(requestedInit().method).toBe("PATCH");
  });

  it("archiveGoal POSTs to /api/jars/:jarId/goals/:goalId/archive", async () => {
    const { result } = renderHook(() => useGoalMutations(JAR_ID));

    await result.current.archiveGoal(GOAL_ID);

    expect(requestedUrl()).toBe(`/api/jars/${JAR_ID}/goals/${GOAL_ID}/archive`);
    expect(requestedInit().method).toBe("POST");
  });

  it("reorderGoals POSTs the full ordered id list to /api/jars/:jarId/goals/reorder", async () => {
    const { result } = renderHook(() => useGoalMutations(JAR_ID));

    await result.current.reorderGoals(["g1", "g2", "g3"]);

    expect(requestedUrl()).toBe(`/api/jars/${JAR_ID}/goals/reorder`);
    expect(requestedInit().method).toBe("POST");
    expect(JSON.parse(requestedInit().body as string)).toEqual({ goalIds: ["g1", "g2", "g3"] });
  });
});

// ─── Regression assertion ────────────────────────────────────────────────────

describe("the specific 404 shape Owner QA hit", () => {
  it("no goals or financial-summary request omits the /api prefix", async () => {
    const { result } = renderHook(() => useGoalMutations(JAR_ID));

    await result.current.createGoal({ name: "x", targetPrincipalCents: 1 });
    await result.current.updateGoal(GOAL_ID, { name: "y" });
    await result.current.archiveGoal(GOAL_ID);
    await result.current.reorderGoals([GOAL_ID]);

    const urls = customFetch.mock.calls.map((c) => c[0]);
    expect(urls).toHaveLength(4);

    // `/jars/...` (the bug) rather than `/api/jars/...` (the fix).
    expect(urls.filter((u) => u.startsWith("/jars/"))).toEqual([]);
    expect(urls.every((u) => u.startsWith("/api/jars/"))).toBe(true);
  });
});
