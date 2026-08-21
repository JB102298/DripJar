/**
 * Agreement 2.0 — parity, correctness, and immutability (Owner QA items 5, 9).
 *
 * Three separable concerns, all of which failed silently before.
 *
 * PARITY. The mobile rules screen summarises the agreement a member is about to
 * accept. Nothing connected the two, so the screen could — and did — describe a
 * rule the document did not contain. The summary is now keyed by clause id, and
 * this file asserts the two lists cover exactly the same ids. Adding a clause
 * server-side without adding a summary is a build failure, which is the point:
 * a member should never accept a term the screen did not mention.
 *
 * The mobile file is read from disk rather than imported. The API package does
 * not depend on the mobile package and should not start; `brand-guard.test.ts`
 * already establishes cross-package source reading as the way this repo does
 * this kind of check.
 *
 * CORRECTNESS. Version 1.0 said funds become committed "once a Commitment
 * Request is approved and the Lock Date has passed" — that a group vote moves
 * members' money. It never did. `routes/commitments.ts` records votes and calls
 * no ledger primitive; principal moves only through `routes/fund-commitment.ts`,
 * scoped to the caller's own member id and rejecting a snapshot whose ownership
 * does not match. These tests pin the corrected wording and pin out the old
 * claim.
 *
 * IMMUTABILITY. A member accepted specific wording on a specific date and that
 * record is evidence. Editing the agreement text must change what NEW jars
 * store and nothing else.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import request from "supertest";
import { db, agreements } from "@workspace/db";
import { eq } from "drizzle-orm";
import app from "../app.js";
import {
  AGREEMENT_CLAUSES,
  AGREEMENT_CLAUSE_IDS,
  AGREEMENT_REQUIRES_LEGAL_REVIEW,
  AGREEMENT_VERSION,
  getAgreementClause,
  renderAgreementText,
} from "../lib/agreement.js";

const WORKSPACE_ROOT = join(__dirname, "../../../..");
const MOBILE_RULES_PATH = join(WORKSPACE_ROOT, "artifacts/mobile/lib/agreement-rules.ts");
const API_SRC = join(__dirname, "..");

const unique = () => `ag-${Date.now()}-${Math.random().toString(36).slice(2)}`;

// ─── Reading the mobile half ─────────────────────────────────────────────────

const mobileSource = readFileSync(MOBILE_RULES_PATH, "utf-8");

/** Clause ids listed in the mobile AGREEMENT_SHORT_RULES array, in order. */
function mobileShortRuleIds(): string[] {
  const start = mobileSource.indexOf("AGREEMENT_SHORT_RULES");
  expect(start, "AGREEMENT_SHORT_RULES not found in the mobile file").toBeGreaterThan(-1);
  const end = mobileSource.indexOf("] as const;", start);
  expect(end, "AGREEMENT_SHORT_RULES array is not terminated as expected").toBeGreaterThan(start);
  const block = mobileSource.slice(start, end);
  return [...block.matchAll(/^\s*id:\s*'([^']+)',/gm)].map((m) => m[1]!);
}

/** The AGREEMENT_VERSION literal declared on the mobile side. */
function mobileAgreementVersion(): string {
  const match = /export const AGREEMENT_VERSION = '([^']+)';/.exec(mobileSource);
  expect(match, "AGREEMENT_VERSION not found in the mobile file").not.toBeNull();
  return match![1]!;
}

// ─── Clause list shape ───────────────────────────────────────────────────────

describe("clause list is well-formed", () => {
  it("has unique, non-empty ids", () => {
    expect(AGREEMENT_CLAUSE_IDS.length).toBeGreaterThan(0);
    expect(new Set(AGREEMENT_CLAUSE_IDS).size).toBe(AGREEMENT_CLAUSE_IDS.length);
    for (const id of AGREEMENT_CLAUSE_IDS) expect(id.trim()).not.toBe("");
  });

  it("gives every clause a heading and a body", () => {
    for (const clause of AGREEMENT_CLAUSES) {
      expect(clause.heading.trim(), `${clause.id} has no heading`).not.toBe("");
      expect(clause.body.trim(), `${clause.id} has no body`).not.toBe("");
    }
  });

  it("looks clauses up by id", () => {
    expect(getAgreementClause("refunds")?.heading).toBe("REFUNDS");
    expect(getAgreementClause("no-such-clause")).toBeUndefined();
  });
});

// ─── Parity with the mobile summary ──────────────────────────────────────────

describe("mobile summary covers exactly the server's clauses", () => {
  it("covers the same clause ids", () => {
    expect([...mobileShortRuleIds()].sort()).toEqual([...AGREEMENT_CLAUSE_IDS].sort());
  });

  it("summarises every clause — none may be accepted unmentioned", () => {
    const summarised = new Set(mobileShortRuleIds());
    for (const id of AGREEMENT_CLAUSE_IDS) {
      expect(summarised.has(id), `clause "${id}" has no plain-language summary`).toBe(true);
    }
  });

  it("summarises no clause that does not exist", () => {
    const known = new Set(AGREEMENT_CLAUSE_IDS);
    for (const id of mobileShortRuleIds()) {
      expect(known.has(id), `summary "${id}" describes no clause`).toBe(true);
    }
  });

  it("declares the same version on both sides", () => {
    expect(mobileAgreementVersion()).toBe(AGREEMENT_VERSION);
  });
});

// ─── Rendered document ───────────────────────────────────────────────────────

describe("rendered agreement text", () => {
  const text = renderAgreementText();

  it("numbers clauses sequentially from the list order", () => {
    // Numbering is derived, so inserting a clause cannot leave two "4."s.
    AGREEMENT_CLAUSES.forEach((clause, index) => {
      expect(text).toContain(`${index + 1}. ${clause.heading}:`);
    });
  });

  it("contains every clause body", () => {
    for (const clause of AGREEMENT_CLAUSES) {
      expect(text, `body of ${clause.id} is missing`).toContain(clause.body);
    }
  });

  it("states its own version", () => {
    expect(text).toContain(`v${AGREEMENT_VERSION}`);
  });

  it("no longer claims a vote commits members' funds", () => {
    // The 1.0 sentence, and the machinery it invoked.
    expect(text).not.toMatch(/Lock Date/i);
    expect(text).not.toMatch(/approved and the Lock Date has passed/i);
  });

  it("says explicitly that only the member commits their own principal", () => {
    expect(text).toMatch(/each member funds their own share/i);
    expect(text).toMatch(/no other member, and no vote, can commit your principal/i);
  });

  it("still describes the approval vote", () => {
    // The correction removes a false claim, not the fact that a vote happens.
    expect(text).toMatch(/members vote/i);
    expect(text).toMatch(/approval threshold/i);
  });

  it("discloses the service fee, which 1.0 charged and never mentioned", () => {
    expect(text).toMatch(/service fee/i);
    expect(text).toMatch(/not returned when principal is refunded/i);
  });

  it("keeps the customer-facing test-mode disclosure", () => {
    expect(text).toMatch(/test mode/i);
    expect(text).toMatch(/no real money is transferred/i);
  });
});

// ─── Internal legal-review marker ────────────────────────────────────────────

describe("legal-review marker", () => {
  it("is retained and set", () => {
    // The wording was written by engineers to describe system behaviour. It has
    // not been reviewed by counsel and must be before real money moves.
    expect(AGREEMENT_REQUIRES_LEGAL_REVIEW).toBe(true);
  });

  it("stays internal — it is not leaked into the customer-facing document", () => {
    const text = renderAgreementText();
    expect(text).not.toMatch(/legal review/i);
    expect(text).not.toMatch(/AGREEMENT_REQUIRES_LEGAL_REVIEW/);
  });

  it("is not exposed on any API response body", () => {
    // A grep, not a request: this asserts no route can ever serialise it.
    const files: string[] = [];
    (function walk(dir: string) {
      for (const entry of readdirSync(dir)) {
        if (entry === "node_modules" || entry === "dist" || entry === "__tests__") continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (extname(full) === ".ts") files.push(full);
      }
    })(join(API_SRC, "routes"));

    for (const file of files) {
      expect(
        readFileSync(file, "utf-8").includes("AGREEMENT_REQUIRES_LEGAL_REVIEW"),
        `${file} references the internal legal-review marker`,
      ).toBe(false);
    }
  });
});

// ─── Immutability of stored agreements ───────────────────────────────────────

describe("stored agreements are never rewritten", () => {
  it("has no code path that updates an agreements row", () => {
    // Acceptance is recorded per agreement id, so a version change is an
    // INSERT plus re-acceptance — never an edit of text a member already
    // accepted.
    const offenders: string[] = [];
    (function walk(dir: string) {
      for (const entry of readdirSync(dir)) {
        if (entry === "node_modules" || entry === "dist" || entry === "__tests__") continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (extname(full) === ".ts") {
          const content = readFileSync(full, "utf-8");
          if (/\.update\(\s*agreements\s*\)/.test(content)) offenders.push(full);
        }
      }
    })(API_SRC);

    expect(offenders, `agreements rows are mutated in: ${offenders.join(", ")}`).toEqual([]);
  });
});

describe("agreement lifecycle against the real app", () => {
  let token: string;
  let firstJarId: string;

  beforeAll(async () => {
    const reg = await request(app).post("/api/auth/register").send({
      email: `${unique()}@example.com`,
      password: "password123",
      firstName: "Ag",
      lastName: "Test",
    });
    expect(reg.status).toBe(201);
    token = reg.body.token as string;

    const jar = await request(app)
      .post("/api/jars")
      .set("Authorization", `Bearer ${token}`)
      .send({
        name: `Agreement Jar ${unique()}`,
        category: "EmergencyFund",
        goalAmountCents: 100_000,
        targetDate: new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10),
      });
    expect(jar.status).toBe(201);
    firstJarId = jar.body.id as string;
  });

  it("writes the current version and rendered text on jar creation", async () => {
    const rows = await db.select().from(agreements).where(eq(agreements.jarId, firstJarId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.version).toBe(AGREEMENT_VERSION);
    expect(rows[0]!.content).toBe(renderAgreementText());
  });

  it("serves the same text through the API", async () => {
    const res = await request(app)
      .get(`/api/jars/${firstJarId}/agreements`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body[0].version).toBe(AGREEMENT_VERSION);
    expect(res.body[0].content).toBe(renderAgreementText());
  });

  it("leaves an already-accepted 1.0 agreement byte-identical", async () => {
    // Stand in for the jars that exist today: a 1.0 row with the old wording,
    // accepted by a member.
    const LEGACY_TEXT = "DripJar Savings Agreement\n\n1. SAVING PHASE: legacy wording.";
    const [legacy] = await db
      .insert(agreements)
      .values({
        jarId: firstJarId,
        version: "1.0",
        content: LEGACY_TEXT,
        effectiveDate: "2026-01-01",
      })
      .returning();

    await request(app)
      .post(`/api/jars/${firstJarId}/agreements/${legacy!.id}/accept`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    // Creating another jar exercises the agreement-writing path again.
    const other = await request(app)
      .post("/api/jars")
      .set("Authorization", `Bearer ${token}`)
      .send({
        name: `Agreement Jar B ${unique()}`,
        category: "Vacation",
        goalAmountCents: 50_000,
        targetDate: new Date(Date.now() + 120 * 86_400_000).toISOString().slice(0, 10),
      });
    expect(other.status).toBe(201);

    const [after] = await db.select().from(agreements).where(eq(agreements.id, legacy!.id));
    expect(after!.version).toBe("1.0");
    expect(after!.content).toBe(LEGACY_TEXT);
  });
});
