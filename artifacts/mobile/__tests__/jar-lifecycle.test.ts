/**
 * Jar lifecycle presentation model.
 *
 * Owner QA: the cancelled Disney jar sat under a tab labelled "Archived",
 * advertised "days left", and carried an "At Risk" badge. Three surfaces each
 * decided what a status meant, so each was wrong in its own way.
 *
 * `describeJarLifecycle` is now the only thing that decides. These tests pin
 * those decisions — including the ones it deliberately refuses to make.
 */
import { describe, it, expect } from "vitest";
import { JarStatus } from "@workspace/api-client-react";
import {
  describeJarLifecycle,
  ACTIVE_JAR_STATUSES,
  COMPLETED_JAR_STATUSES,
  CANCELLED_JAR_STATUSES,
  JAR_TABS,
  statusParamForTab,
  type JarLifecycle,
} from "../lib/jar-status";

const ALL_STATUSES = Object.values(JarStatus) as string[];
const lc = (status: string): JarLifecycle => describeJarLifecycle({ status });

describe("every stored status lands in exactly one bucket", () => {
  it("assigns a bucket to each status in the spec enum", () => {
    for (const s of ALL_STATUSES) expect(lc(s).bucket, `${s} must have a bucket`).not.toBeNull();
  });

  it("puts each status in exactly one jar-backed bucket", () => {
    for (const s of ALL_STATUSES) {
      const hits = [ACTIVE_JAR_STATUSES, COMPLETED_JAR_STATUSES, CANCELLED_JAR_STATUSES].filter(
        (set) => set.includes(s as never),
      );
      expect(hits, `${s} belongs to ${hits.length} buckets`).toHaveLength(1);
    }
  });

  it("agrees with the tab query parameter for every status", () => {
    for (const s of ALL_STATUSES) {
      const bucket = lc(s).bucket!;
      expect(statusParamForTab(bucket)!.split(","), `${s} → ${bucket} tab`).toContain(s);
    }
  });
});

describe("Invited is membership state, not lifecycle state", () => {
  it("is a tab but never a lifecycle bucket", () => {
    expect(JAR_TABS).toContain("Invited");
    for (const s of ALL_STATUSES) expect(lc(s).bucket).not.toBe("Invited");
  });

  it("is not backed by GET /jars", () => {
    expect(statusParamForTab("Invited")).toBeUndefined();
  });
});

describe("there is no archive", () => {
  it("has no Archived tab", () => {
    expect(JAR_TABS).not.toContain("Archived" as never);
  });

  it("files Cancelled under Cancelled, never Archived", () => {
    expect(lc(JarStatus.Cancelled).bucket).toBe("Cancelled");
    expect(lc(JarStatus.Cancelled).label).toBe("Cancelled");
  });

  it("keeps Completed and Cancelled distinct", () => {
    const c = lc(JarStatus.Completed);
    const x = lc(JarStatus.Cancelled);
    expect(c.bucket).not.toBe(x.bucket);
    expect(c.label).not.toBe(x.label);
    expect(c.terminalCopy).not.toBe(x.terminalCopy);
  });
});

describe("terminal jars stop making active claims", () => {
  it.each([JarStatus.Cancelled, JarStatus.Completed])("%s is terminal and inert", (s) => {
    const l = lc(s);
    expect(l.isTerminal).toBe(true);
    expect(l.isActive).toBe(false);
    expect(l.showCountdown).toBe(false);
    expect(l.showHealth).toBe(false);
    expect(l.terminalCopy).toBeTruthy();
  });

  it("shows no lifecycle date, because none is stored", () => {
    // `jars` has no cancelled_at/completed_at; the API exposes only `updatedAt`,
    // which unrelated edits touch. Rendering it would invent a fact.
    for (const s of [JarStatus.Cancelled, JarStatus.Completed]) {
      expect(lc(s).dateToShow).toBe("none");
    }
  });

  it("never describes a terminal jar as a phase it is passing through", () => {
    expect(lc(JarStatus.Cancelled).label).not.toMatch(/phase/i);
    expect(lc(JarStatus.Completed).label).not.toMatch(/phase/i);
  });
});

describe("active jars keep their countdown and health", () => {
  it.each(ACTIVE_JAR_STATUSES)("%s stays active", (s) => {
    const l = lc(s);
    expect(l.isActive).toBe(true);
    expect(l.isTerminal).toBe(false);
    expect(l.showCountdown).toBe(true);
    expect(l.showHealth).toBe(true);
    expect(l.dateToShow).toBe("target");
    expect(l.terminalCopy).toBeNull();
  });
});

describe("lifecycleAllowsContributions covers the STATUS gate only", () => {
  // Necessary, not sufficient. The server additionally requires authorization,
  // active membership, current agreement acceptance, payment readiness, and
  // amount/idempotency/rate-limit checks. These tests assert only the status
  // half — they must never be read as proof that a contribution would succeed.
  it("matches the status half of POST /jars/:id/contributions", () => {
    const allowed = ALL_STATUSES.filter((s) => lc(s).lifecycleAllowsContributions);
    expect(allowed.sort()).toEqual([JarStatus.CommitmentPending, JarStatus.Saving].sort());
  });

  it("is false for every terminal status", () => {
    for (const s of [JarStatus.Cancelled, JarStatus.Completed]) {
      expect(lc(s).lifecycleAllowsContributions).toBe(false);
    }
  });

  it("is false for a Draft jar that has not launched", () => {
    expect(lc(JarStatus.Draft).lifecycleAllowsContributions).toBe(false);
  });

  it("does not claim to be an eligibility verdict", () => {
    // A true value means "the lifecycle does not forbid this", nothing more.
    // No field here may imply the server would accept the contribution.
    const l = lc(JarStatus.Saving) as unknown as Record<string, unknown>;
    expect(l).not.toHaveProperty("canContribute");
    expect(l).not.toHaveProperty("mayContribute");
    expect(l["lifecycleAllowsContributions"]).toBe(true);
  });
});

describe("refund eligibility is entirely outside this model", () => {
  it("exposes no refund field for any status", () => {
    // Refundability is the member's uncommitted balance from getRefundableLots,
    // surfaced by GET /jars/:id/refunds/preview — which ignores jar.status.
    // A status-derived refund verdict here would hard-code stranded funds.
    for (const s of ALL_STATUSES) {
      const l = lc(s) as unknown as Record<string, unknown>;
      for (const f of ["canRefund", "showRefund", "refundable", "lifecycleAllowsRefunds"]) {
        expect(l, `${s} must not carry ${f}`).not.toHaveProperty(f);
      }
    }
  });

  it("says nothing about refunds in terminal copy", () => {
    for (const s of [JarStatus.Cancelled, JarStatus.Completed]) {
      expect(String(lc(s).terminalCopy)).not.toMatch(/refund/i);
    }
  });
});

describe("unknown statuses fail closed", () => {
  it.each(["Archived", "Paused", "", "saving", "LEGACY_STATE"])(
    "%s is neither active nor terminal and gets no affordances",
    (s) => {
      const l = lc(s);
      expect(l.bucket).toBeNull();
      expect(l.isActive).toBe(false);
      expect(l.showCountdown).toBe(false);
      expect(l.showHealth).toBe(false);
      expect(l.lifecycleAllowsContributions).toBe(false);
    },
  );

  it("never lets an unknown status inherit Active", () => {
    expect(lc("SomethingNew").bucket).not.toBe("Active");
  });
});

describe("restoration is not implied", () => {
  it("offers no transition back out of a terminal state", () => {
    for (const s of [JarStatus.Cancelled, JarStatus.Completed]) {
      const l = lc(s) as unknown as Record<string, unknown>;
      expect(l).not.toHaveProperty("canRestore");
      expect(l).not.toHaveProperty("canReopen");
      expect(String(l["terminalCopy"])).not.toMatch(/restore|reopen|reactivate|undo/i);
    }
  });
});
