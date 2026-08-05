"use strict";
const PDFDocument = require("pdfkit");
const fs = require("fs");
const path = require("path");

const out = path.join(__dirname, "..", "phase4d-final-report.pdf");
const doc = new PDFDocument({ margin: 50, size: "A4" });
doc.pipe(fs.createWriteStream(out));

// ── helpers ───────────────────────────────────────────────────────────────────
const W = doc.page.width - 100;
const MONO = "Courier";
const SANS = "Helvetica";
const BOLD = "Helvetica-Bold";

function h1(text) {
  doc.font(BOLD).fontSize(18).fillColor("#1a1a2e").text(text);
  doc.moveDown(0.4);
}
function h2(text) {
  doc.font(BOLD).fontSize(13).fillColor("#16213e").text(text);
  doc.moveDown(0.3);
}
function h3(text) {
  doc.font(BOLD).fontSize(11).fillColor("#0f3460").text(text);
  doc.moveDown(0.2);
}
function body(text, opts = {}) {
  doc.font(SANS).fontSize(10).fillColor("#222").text(text, opts);
  doc.moveDown(0.25);
}
function mono(text) {
  doc.font(MONO).fontSize(9).fillColor("#333").text(text);
  doc.moveDown(0.15);
}
function rule() {
  const y = doc.y;
  doc.moveTo(50, y).lineTo(doc.page.width - 50, y).strokeColor("#ccc").lineWidth(0.5).stroke();
  doc.moveDown(0.4);
}
function bullet(text, indent = 65) {
  const x = doc.x;
  doc.font(SANS).fontSize(10).fillColor("#222")
    .text("•  " + text, { indent: indent - 50 });
  doc.moveDown(0.15);
}
function checkRow(label, pass) {
  const mark = pass ? "✓" : "✗";
  const color = pass ? "#166534" : "#991b1b";
  doc.font(BOLD).fontSize(10).fillColor(color).text(mark + "  ", { continued: true });
  doc.font(SANS).fontSize(10).fillColor("#222").text(label);
  doc.moveDown(0.15);
}
function sectionBreak() {
  doc.moveDown(0.8);
  rule();
}

// ══════════════════════════════════════════════════════════════════════════════
// COVER
// ══════════════════════════════════════════════════════════════════════════════
doc.rect(0, 0, doc.page.width, 160).fill("#0f3460");
doc.font(BOLD).fontSize(26).fillColor("#ffffff").text("M3Jar — Phase 4D Final Report", 50, 50);
doc.font(SANS).fontSize(13).fillColor("#a8c0e8").text("Jar Goals + Financial Transparency", 50, 90);
doc.font(SANS).fontSize(11).fillColor("#c8daf5").text("Delivered: August 5, 2026", 50, 115);
doc.font(MONO).fontSize(9).fillColor("#7aa3d0").text("HEAD === origin/main  |  All 501 tests passing  |  3 typechecks clean", 50, 140);
doc.moveDown(5);

// ══════════════════════════════════════════════════════════════════════════════
// 1. EXECUTIVE SUMMARY
// ══════════════════════════════════════════════════════════════════════════════
h1("1. Executive Summary");
body(
  "Phase 4D adds jar goal planning and full financial transparency to the M3Jar savings platform. " +
  "Organizers can define, order, and archive named funding goals that are automatically waterfall-allocated " +
  "from real ledger principal. A new financial-summary endpoint surfaces privacy-scoped breakdowns: " +
  "organizers see exact figures per member; regular members see their own exact data plus only a " +
  "status label and percent-funded for others. All 501 backend tests pass on a single test run. " +
  "Typechecks are clean across api-server, mobile, and lib/db. The commit is live on origin/main."
);
sectionBreak();

// ══════════════════════════════════════════════════════════════════════════════
// 2. ARCHITECTURE DECISIONS
// ══════════════════════════════════════════════════════════════════════════════
h1("2. Architecture Decisions (Pre-Approved)");

h2("2a. Ledger-backed totalSavedCents");
body(
  "The old getTotalSaved() queried the contributions table. Phase 4D replaces it with " +
  "getJarSavedPrincipalCents() that reads ledger_entries. The formula:"
);
mono("  savedPrincipalCents = refundablePrincipalCents + committedPrincipalCents");
body(
  "Rows with type IN ('refund_pending','refunded','drip_jar_fee','processing_fee') and " +
  "simulated contribution rows are excluded. The same formula is used everywhere: the progress bar, " +
  "the jar health endpoint, the financial summary, and the goal waterfall."
);

h2("2b. sort_order Strategy");
body(
  "Sequential integers (1, 2, 3…). On every reorder, all active goals for the jar are fully " +
  "reassigned inside a single transaction. No fractional / float ordering. No DB UNIQUE constraint " +
  "on sort_order (duplicates during mid-transaction state are harmless and the final state is always correct)."
);

h2("2c. Goal Deletion Policy");
body(
  "Hard delete when jar.status IN ('Draft', 'Inviting') — goal never launched, no history needed. " +
  "Soft archive (status='archived', archivedAt set) once the jar has launched. Archived goals are " +
  "excluded from the waterfall calculation and from the active target sum used in constraint checks."
);
sectionBreak();

// ══════════════════════════════════════════════════════════════════════════════
// 3. SCHEMA & MIGRATION
// ══════════════════════════════════════════════════════════════════════════════
h1("3. Schema & Migration");

h2("Migration 0018 — jar_goals");
mono("lib/db/drizzle/0018_phase4d_jar_goals.sql");
body("New table: jar_goals");
const cols = [
  "id                      UUID PRIMARY KEY DEFAULT gen_random_uuid()",
  "jar_id                  UUID NOT NULL REFERENCES jars(id) ON DELETE CASCADE",
  "name                    TEXT NOT NULL",
  "description             TEXT",
  "target_principal_cents  INTEGER NOT NULL  CHECK (target_principal_cents > 0)",
  "sort_order              INTEGER NOT NULL DEFAULT 0",
  "status                  TEXT NOT NULL DEFAULT 'active'  CHECK (status IN ('active','archived'))",
  "created_at              TIMESTAMPTZ NOT NULL DEFAULT now()",
  "updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()",
  "archived_at             TIMESTAMPTZ",
];
cols.forEach(c => mono("  " + c));
body("Index: jar_goals_jar_id_status_sort_idx ON (jar_id, status, sort_order)");
body("The journal entry (idx:18) was registered in meta/_journal.json. Migration applied to the live database.");
body("lib/db was rebuilt (pnpm tsc -p lib/db/tsconfig.json) and all type exports verified.");
sectionBreak();

// ══════════════════════════════════════════════════════════════════════════════
// 4. API SURFACE
// ══════════════════════════════════════════════════════════════════════════════
h1("4. API Surface");

h2("Goals Router  —  artifacts/api-server/src/routes/goals.ts");
const goalRoutes = [
  ["GET    /api/jars/:jarId/goals",                     "active member or organizer  —  waterfall-allocated goals list"],
  ["GET    /api/jars/:jarId/goals?includeArchived=true", "same, plus archived goals in a separate archivedGoals array"],
  ["POST   /api/jars/:jarId/goals",                     "organizer only  —  create goal; sum constraint enforced FOR UPDATE"],
  ["PATCH  /api/jars/:jarId/goals/:goalId",             "organizer only  —  update name/desc/target; sum constraint re-checked"],
  ["POST   /api/jars/:jarId/goals/:goalId/archive",     "organizer only  —  hard delete (Draft/Inviting) or soft archive (Saving+)"],
  ["POST   /api/jars/:jarId/goals/reorder",             "organizer only  —  full reassignment of sort_order 1…N; rejects incomplete/invalid lists"],
];
goalRoutes.forEach(([route, desc]) => {
  doc.font(MONO).fontSize(8.5).fillColor("#0f3460").text(route, { continued: true });
  doc.font(SANS).fontSize(8.5).fillColor("#555").text("  " + desc);
  doc.moveDown(0.15);
});

h2("Financial Summary Router  —  artifacts/api-server/src/routes/financial-summary.ts");
mono("GET  /api/jars/:jarId/financial-summary");
body(
  "Requires active member or organizer. Returns jar-level principal breakdown, goal waterfall, " +
  "and per-member figures. Privacy model:"
);
bullet("Organizer view: exact contributedPrincipalCents, refundable, committed, refundPending, refunded, fees for every member");
bullet("Member view: own exact figures (isOwnData=true) + statusLabel + savedPercent only for all others");
bullet("Invariant check: committedPrincipalCents ≤ savedPrincipalCents always verified and surfaced as invariantHolds");

h2("jars.ts — breaking changes");
body(
  "getTotalSaved() removed. All three call-sites (buildJarSummary, GET /jars/:jarId, GET /jars/:jarId/health) " +
  "replaced with getJarSavedPrincipalCents(jarId) from financial-balance.ts. " +
  "PATCH /jars/:jarId now validates active goal sum ≤ new goalAmountCents when the organizer reduces the jar target."
);
sectionBreak();

// ══════════════════════════════════════════════════════════════════════════════
// 5. PURE WATERFALL FUNCTION
// ══════════════════════════════════════════════════════════════════════════════
h1("5. Pure Waterfall Function");
mono("artifacts/api-server/src/lib/goal-waterfall.ts");
body(
  "computeGoalWaterfall(goals, savedPrincipalCents, committedPrincipalCents) — no DB calls, no side effects. " +
  "Goals are processed in sort_order ascending. For each goal:"
);
bullet("savedAllocatedCents   = min(goal.targetPrincipalCents, remainingSaved)");
bullet("committedAllocatedCents = min(goal.targetPrincipalCents, remainingCommitted)");
bullet("savedPercent = savedAllocated / target × 100");
bullet("fundingState = 'funded' | 'partially_funded' | 'unfunded' (based on savedAllocated vs target)");
body(
  "surplusCents = max(0, savedPrincipalCents − sum of all active goal targets). " +
  "unallocatedCents is computed at the route level as max(0, jar.goalAmountCents − activeGoalTargetSum)."
);
sectionBreak();

// ══════════════════════════════════════════════════════════════════════════════
// 6. INVARIANTS ENFORCED
// ══════════════════════════════════════════════════════════════════════════════
h1("6. Key Invariants Enforced");

const invariants = [
  "Goal mutations create ZERO ledger_entries and ZERO financial_transactions (verified by PART I tests)",
  "savedPrincipalCents = refundablePrincipalCents + committedPrincipalCents (fees and refunds excluded)",
  "committedPrincipalCents ≤ savedPrincipalCents at all times (invariantHolds flag in financial summary)",
  "SUM(active goal targets) ≤ jars.goalAmountCents — enforced inside SELECT…FOR UPDATE transaction",
  "Archived goals excluded from waterfall and from the active target sum used in constraint checks",
  "Hard delete only in Draft/Inviting; soft archive (preserves history) once jar has launched",
  "All allocation is derived at query time — targetPrincipalCents is the only stored goal amount",
  "Members cannot see other members' exact dollar balances — only their own + statusLabel for others",
];
invariants.forEach(i => bullet(i));
sectionBreak();

// ══════════════════════════════════════════════════════════════════════════════
// 7. MOBILE UI
// ══════════════════════════════════════════════════════════════════════════════
h1("7. Mobile UI (Phase 4D)");

h2("New Hooks");
mono("artifacts/mobile/hooks/useJarGoals.ts");
body(
  "useJarGoals(jarId, options) — queries GET /jars/:jarId/goals via customFetch (auto-authenticated). " +
  "Enabled only when the Overview tab is active. Returns goals[], unallocatedCents, surplusCents, " +
  "savedPrincipalCents, committedPrincipalCents, goalAmountCents."
);
mono("artifacts/mobile/hooks/useFinancialSummary.ts");
body(
  "useFinancialSummary(jarId, options) — queries GET /jars/:jarId/financial-summary. " +
  "Returns full JarFinancials, GoalAllocation[], MemberFinancialSummary[], viewerRole, invariantHolds."
);

h2("Jar Detail Screen — artifacts/mobile/app/jar/[id].tsx");
body(
  "renderOverview() updated to render two new sections below the action row:"
);
bullet("Goals Section: shows each active goal with a ProgressBar, funding-state icon (Feather), " +
  "saved/target amounts, and a 'Manage' link for organizers. Unallocated bucket shown when > 0.");
bullet("Financial Details accordion: collapsed by default, expands to show refundable/locked/pending/refunded/ " +
  "fee breakdown. Uses Feather chevron-up/down icon. Over-target warning shown in amber if applicable.");
body(
  "onRefresh() updated to concurrently refetch goals and financial summary on Overview tab pull-to-refresh."
);
sectionBreak();

// ══════════════════════════════════════════════════════════════════════════════
// 8. TEST COVERAGE
// ══════════════════════════════════════════════════════════════════════════════
h1("8. Test Coverage");

h2("phase4d-goals.test.ts  (≈ 42 tests across 10 PARTS)");
const goalParts = [
  "A  GET goals — empty state: structure, unallocated = jar target, surplus = 0",
  "B  POST goals — create, auto-increment sortOrder, sum constraint (409), field validation",
  "C  Authorization — member read-only, outsider 403, unauthenticated 401, organizer-only mutations",
  "D  PATCH goal — name/desc/target updates, sum constraint, 404 for unknown goal",
  "E  Archive — hard delete (Draft jar), soft archive (Saving jar), 404 on re-archive of deleted",
  "F  Reorder — canonical sort_order 1…N, reject incomplete list, duplicates, invalid IDs, empty array",
  "G  Waterfall algebra — all unfunded with zero principal, unallocated math, surplus = 0, ascending order",
  "H  Archived goals excluded — active list shrinks, unallocatedCents recalculates, includeArchived param",
  "I  Invariant — POST/PATCH/reorder/archive create zero ledger_entries and zero financial_transactions",
  "J  PATCH jar amount constraint — allow increase, reject < goal sum (409), allow exactly = goal sum",
];
goalParts.forEach(p => bullet(p));

h2("phase4d-transparency.test.ts  (≈ 30 tests across 6 PARTS)");
const transParts = [
  "A  Zero state — top-level shape, all totals = 0, remainingToSave = goalAmountCents, goals = []",
  "B  Authorization — organizer 200, active member 200, outsider 403, unauthenticated 401",
  "C  Privacy model — organizer sees exact figures for all; member sees own exact + others redacted",
  "D  Goal waterfall — all goals unfunded at zero principal, unallocatedCents math, endpoint parity",
  "E  Jar-level totals — remainingToSaveCents, isOverTarget = false at zero state, currency propagation",
  "F  Ledger-backed totalSaved — GET /jars/:jarId and GET /jars return totalSavedCents=0 with no real payments",
];
transParts.forEach(p => bullet(p));

h2("Full Suite Result");
doc.font(BOLD).fontSize(12).fillColor("#166534").text("19 test files  |  501 tests  |  501 passed  |  0 failed");
doc.moveDown(0.4);
sectionBreak();

// ══════════════════════════════════════════════════════════════════════════════
// 9. DELIVERY CHECKLIST
// ══════════════════════════════════════════════════════════════════════════════
h1("9. Delivery Checklist");

const checks = [
  [true,  "Migration 0018 (jar_goals) applied to live database"],
  [true,  "meta/_journal.json updated with idx:18 entry"],
  [true,  "lib/db rebuilt; jarGoals exported from @workspace/db"],
  [true,  "jarGoals table definition + jarGoalsRelations in schema/index.ts"],
  [true,  "computeGoalWaterfall() pure function — no DB calls, no side effects"],
  [true,  "getJarSavedPrincipalCents() replaces getTotalSaved() — all 3 call-sites updated"],
  [true,  "goals.ts — all 6 endpoints with correct auth, validation, constraint enforcement"],
  [true,  "financial-summary.ts — privacy-scoped member breakdowns + goal waterfall"],
  [true,  "jars.ts PATCH — goal sum constraint check added"],
  [true,  "routes/index.ts — goalsRouter and financialSummaryRouter registered"],
  [true,  "ActivityEventType extended: goal_created, goal_updated, goal_archived, goal_reordered"],
  [true,  "useJarGoals.ts + useFinancialSummary.ts mobile hooks created"],
  [true,  "jar/[id].tsx — Goals section + Financial Details accordion in renderOverview"],
  [true,  "onRefresh() includes concurrent refetch for goals and financial summary"],
  [true,  "phase4d-goals.test.ts — 10 test parts, all passing"],
  [true,  "phase4d-transparency.test.ts — 6 test parts, all passing"],
  [true,  "api-server typecheck: CLEAN"],
  [true,  "mobile typecheck: CLEAN"],
  [true,  "lib/db typecheck: CLEAN"],
  [true,  "Full test suite: 501/501 passing"],
  [true,  "Committed to main: 141523e"],
  [true,  "Pushed to origin/main (JB102298/TripJar)"],
];
checks.forEach(([pass, label]) => checkRow(label, pass));
sectionBreak();

// ══════════════════════════════════════════════════════════════════════════════
// 10. FILES CHANGED
// ══════════════════════════════════════════════════════════════════════════════
h1("10. Files Changed");

const files = [
  // New
  ["NEW", "lib/db/drizzle/0018_phase4d_jar_goals.sql"],
  ["NEW", "artifacts/api-server/src/lib/goal-waterfall.ts"],
  ["NEW", "artifacts/api-server/src/routes/goals.ts"],
  ["NEW", "artifacts/api-server/src/routes/financial-summary.ts"],
  ["NEW", "artifacts/api-server/src/__tests__/phase4d-goals.test.ts"],
  ["NEW", "artifacts/api-server/src/__tests__/phase4d-transparency.test.ts"],
  ["NEW", "artifacts/mobile/hooks/useJarGoals.ts"],
  ["NEW", "artifacts/mobile/hooks/useFinancialSummary.ts"],
  // Modified
  ["MOD", "lib/db/drizzle/meta/_journal.json"],
  ["MOD", "lib/db/src/schema/index.ts"],
  ["MOD", "artifacts/api-server/src/lib/activity.ts"],
  ["MOD", "artifacts/api-server/src/lib/financial-balance.ts"],
  ["MOD", "artifacts/api-server/src/routes/jars.ts"],
  ["MOD", "artifacts/api-server/src/routes/index.ts"],
  ["MOD", "artifacts/mobile/app/jar/[id].tsx"],
];
files.forEach(([tag, file]) => {
  const color = tag === "NEW" ? "#166534" : "#92400e";
  doc.font(BOLD).fontSize(9).fillColor(color).text(`[${tag}]  `, { continued: true });
  doc.font(MONO).fontSize(9).fillColor("#222").text(file);
  doc.moveDown(0.12);
});

// ══════════════════════════════════════════════════════════════════════════════
// FOOTER
// ══════════════════════════════════════════════════════════════════════════════
doc.moveDown(1.5);
rule();
doc.font(SANS).fontSize(9).fillColor("#888").text(
  "M3Jar Phase 4D  ·  Generated August 5, 2026  ·  Commit 141523e  ·  501/501 tests pass",
  { align: "center" }
);

doc.end();
console.log("Written:", out);
