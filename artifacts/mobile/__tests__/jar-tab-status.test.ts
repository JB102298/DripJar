/**
 * My Jars tab → status mapping — Owner QA item 10
 *
 * The Active tab sent `"Saving,FullyFunded"`. Two things were wrong: the API
 * compared that string with `===` (fixed server-side, see
 * api-server/src/__tests__/jar-status-filter.test.ts), and the mapping itself
 * omitted `Draft` — the status `POST /jars` actually assigns — so a freshly
 * created jar had no tab to appear in even once the filter worked.
 *
 * These tests pin the mapping, not the maths. The screen test
 * (jars-screen.test.tsx) proves the screen uses it.
 */
import { describe, it, expect } from "vitest";
import {
  ACTIVE_JAR_STATUSES,
  COMPLETED_JAR_STATUSES,
  CANCELLED_JAR_STATUSES,
  JAR_TABS,
  statusParamForTab,
  pendingInvitations,
} from "../lib/jar-status";
import { JarStatus } from "@workspace/api-client-react";

const ALL_STATUSES = Object.values(JarStatus);

describe("Active tab covers every live lifecycle status", () => {
  it("includes Draft — the status a newly created jar is given", () => {
    // The reported bug. POST /jars stores "Draft"; if Active omits it, the jar
    // the user just created is invisible everywhere.
    expect(ACTIVE_JAR_STATUSES).toContain(JarStatus.Draft);
  });

  it("includes every non-terminal status", () => {
    expect([...ACTIVE_JAR_STATUSES].sort()).toEqual(
      [
        JarStatus.Draft,
        JarStatus.Inviting,
        JarStatus.Saving,
        JarStatus.CommitmentPending,
        JarStatus.Committed,
        JarStatus.FullyFunded,
      ].sort(),
    );
  });

  it("excludes the terminal statuses, which have their own tabs", () => {
    expect(ACTIVE_JAR_STATUSES).not.toContain(JarStatus.Completed);
    expect(ACTIVE_JAR_STATUSES).not.toContain(JarStatus.Cancelled);
  });
});

describe("the tabs partition the status space", () => {
  const jarBackedStatuses = [
    ...ACTIVE_JAR_STATUSES,
    ...COMPLETED_JAR_STATUSES,
    ...CANCELLED_JAR_STATUSES,
  ];

  it("assigns every generated JarStatus to exactly one tab", () => {
    // If a new status is added to the spec and nobody updates this file, the
    // jars carrying it would be invisible in every tab. This is the tripwire.
    for (const status of ALL_STATUSES) {
      expect(
        jarBackedStatuses.filter((s) => s === status),
        `status ${status} should belong to exactly one tab`,
      ).toHaveLength(1);
    }
  });

  it("introduces no status the API does not know about", () => {
    for (const status of jarBackedStatuses) {
      expect(ALL_STATUSES).toContain(status);
    }
  });
});

describe("statusParamForTab", () => {
  it("sends a comma-separated list the API can parse", () => {
    expect(statusParamForTab("Active")).toBe(
      "Draft,Inviting,Saving,CommitmentPending,Committed,FullyFunded",
    );
  });

  it("maps the terminal tabs to their single status", () => {
    expect(statusParamForTab("Completed")).toBe("Completed");
    // The tab is named for the status it holds. There is no archive concept in
    // the product, so there is no "Archived" tab to map.
    expect(statusParamForTab("Cancelled")).toBe("Cancelled");
  });

  it("returns undefined for Invited — it is not backed by GET /jars", () => {
    // An invitation you have not accepted is membership state. GET /jars only
    // returns jars you already organize or actively belong to, so no jar-status
    // filter can ever express "invited".
    expect(statusParamForTab("Invited")).toBeUndefined();
  });

  it("emits no blank or whitespace segments", () => {
    for (const tab of JAR_TABS) {
      const param = statusParamForTab(tab);
      if (param === undefined) continue;
      for (const segment of param.split(",")) {
        expect(segment).toBe(segment.trim());
        expect(segment).not.toBe("");
      }
    }
  });
});

describe("pendingInvitations", () => {
  const now = new Date("2026-08-17T00:00:00Z");
  const future = "2026-09-01T00:00:00Z";
  const past = "2026-08-01T00:00:00Z";

  const inv = (status: string, expiresAt: string, id = status + expiresAt) => ({
    id,
    status,
    expiresAt,
  });

  it("keeps pending invitations that have not lapsed", () => {
    expect(pendingInvitations([inv("pending", future)], now)).toHaveLength(1);
  });

  it("drops invitations the user has already resolved", () => {
    const resolved = ["accepted", "declined", "revoked", "expired"].map((s) => inv(s, future));
    expect(pendingInvitations(resolved, now)).toEqual([]);
  });

  it("drops pending invitations whose expiry has passed", () => {
    // The server marks rows `expired` lazily, so a stale `pending` row is
    // reachable and must not be offered as actionable.
    expect(pendingInvitations([inv("pending", past)], now)).toEqual([]);
  });

  it("returns an empty list while the query is still loading", () => {
    expect(pendingInvitations(undefined, now)).toEqual([]);
  });
});
