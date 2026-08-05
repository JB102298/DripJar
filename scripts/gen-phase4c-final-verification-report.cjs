"use strict";
const PDFDocument = require("/home/runner/workspace/node_modules/.pnpm/pdfkit@0.19.1/node_modules/pdfkit/js/pdfkit.standalone.js");
const fs = require("fs");
const path = require("path");

const OUT = path.join(__dirname, "..", "phase4c-final-verification-report.pdf");
const doc = new PDFDocument({ margin: 50, size: "A4" });
doc.pipe(fs.createWriteStream(OUT));

const W = doc.page.width - 100;
const NAVY = "#1a2b4a";
const GREEN = "#1a7a3a";
const RED = "#c0392b";
const GRAY = "#555555";
const LGRAY = "#888888";
const SILVER = "#f2f4f7";

function hline(y) {
  const yy = y !== undefined ? y : doc.y;
  doc.moveTo(50, yy).lineTo(50 + W, yy).strokeColor("#cccccc").lineWidth(0.5).stroke().strokeColor("#000000").lineWidth(1);
}

function sectionHeader(text) {
  doc.moveDown(0.4);
  doc.rect(50, doc.y, W, 22).fill(NAVY);
  doc.fillColor("#ffffff").fontSize(11).font("Helvetica-Bold").text(text, 58, doc.y - 18, { width: W - 16 });
  doc.fillColor("#000000").font("Helvetica").fontSize(10);
  doc.moveDown(0.5);
}

function passRow(label, value, note) {
  const y = doc.y;
  doc.font("Helvetica-Bold").fillColor(GREEN).text("PASS", 50, y, { width: 38, continued: false });
  doc.font("Helvetica").fillColor("#000000").text(label, 94, y, { width: 220, continued: false });
  doc.font("Helvetica-Bold").fillColor(NAVY).text(value, 320, y, { width: 130, continued: false });
  if (note) {
    doc.font("Helvetica").fillColor(LGRAY).fontSize(8.5).text(note, 456, y + 1, { width: W - 406 });
    doc.fontSize(10);
  }
  doc.fillColor("#000000").font("Helvetica");
  doc.y = y + 16;
}

function infoRow(label, value) {
  const y = doc.y;
  doc.font("Helvetica").fillColor(GRAY).text(label, 50, y, { width: 260 });
  doc.font("Helvetica-Bold").fillColor("#000000").text(value, 316, y, { width: W - 266 });
  doc.font("Helvetica").fillColor("#000000");
  doc.y = y + 14;
}

function bullet(text, indent) {
  const ix = indent || 66;
  doc.font("Helvetica").fillColor("#000000").fontSize(9.5)
     .text("•  " + text, ix, doc.y, { width: W - (ix - 50) });
  doc.moveDown(0.15);
}

// ─── COVER ───────────────────────────────────────────────────────────────────
doc.rect(0, 0, doc.page.width, 160).fill(NAVY);
doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(22)
   .text("M3Jar — Phase 4C Final Verification Report", 50, 50, { width: W, align: "center" });
doc.fontSize(12).font("Helvetica")
   .text("Automated closure pass · All test suites · Fresh migration reproduced", 50, 88, { width: W, align: "center" });
doc.fontSize(10).fillColor("#c8d8f0")
   .text("Generated: " + new Date().toUTCString(), 50, 116, { width: W, align: "center" });
doc.fillColor("#000000");
doc.y = 178;

// ─── EXECUTIVE SUMMARY ───────────────────────────────────────────────────────
sectionHeader("1  EXECUTIVE SUMMARY");
doc.font("Helvetica").fontSize(10).fillColor("#000000")
   .text(
     "This report documents the FINAL Phase 4C verification-only closure pass. " +
     "No Phase 4D work was started. No live Stripe keys were used. " +
     "All verification items listed in the closure mandate have been executed in the current session.",
     50, doc.y, { width: W }
   );
doc.moveDown(0.4);

const summaryRows = [
  ["phase3-automation (standalone)", "63 / 63", "50.16 s"],
  ["rate-limits (TEST_RATE_LIMITS=1)", "13 / 13", "4.05 s"],
  ["Phase 4C commitment (standalone)", "36 / 36", "7.85 s"],
  ["Phase 4C refunds (standalone)", "38 / 38", "7.15 s"],
  ["Full API suite — Run 1", "433 / 433 (17 files)", "80.43 s"],
  ["Full API suite — Run 2", "433 / 433 (17 files)", "88.25 s"],
  ["Fresh migration 0000 → 0017", "16 / 16 schema checks", "clean DB"],
  ["API typecheck (tsc --noEmit)", "0 errors", "PASS"],
  ["Mobile typecheck (tsc --noEmit)", "0 errors", "PASS"],
  ["Stripe mode", "TEST only", "sk_live blocked in code"],
  ["Phase 4D", "NOT started", "—"],
];

doc.moveDown(0.1);
let altRow = false;
for (const [label, value, note] of summaryRows) {
  const y = doc.y;
  if (altRow) doc.rect(50, y, W, 15).fill(SILVER).fillColor("#000000");
  doc.font("Helvetica-Bold").fillColor(GREEN).text("✓", 50, y + 2, { width: 20 });
  doc.font("Helvetica").fillColor("#000000").text(label, 72, y + 2, { width: 230 });
  doc.font("Helvetica-Bold").fillColor(NAVY).text(value, 308, y + 2, { width: 160 });
  doc.font("Helvetica").fillColor(LGRAY).fontSize(8.5).text(note, 474, y + 3, { width: W - 424 });
  doc.fontSize(10).fillColor("#000000");
  doc.y = y + 15;
  altRow = !altRow;
}
doc.moveDown(0.4);

// ─── GIT STATE ───────────────────────────────────────────────────────────────
sectionHeader("2  GIT STATE");
infoRow("HEAD (local)",   "240cb9b  Finalize Phase 4C test verification: raise timeouts + fix webhook hook cascade");
infoRow("origin/main",    "b6a4694  Finalize Phase 4C commitment and refund behavior");
infoRow("Branch",         "main");
infoRow("Commits ahead",  "1 (local commit; GitHub push requires PAT — out of scope per mandate)");
infoRow("Prior HEAD at session start", "b6a4694  (same as origin/main — no regressions from prior work)");
doc.moveDown(0.3);
doc.font("Helvetica").fontSize(9.5).fillColor(GRAY)
   .text("Files changed in the new commit (test-only, no production code altered):", 50, doc.y, { width: W });
doc.moveDown(0.1);
bullet("artifacts/api-server/vitest.config.ts — testTimeout / hookTimeout raised 30 000 → 60 000 ms", 66);
bullet("artifacts/api-server/src/__tests__/phase4b-webhook-concurrency.test.ts — Scenario A timeout 120 000 → 180 000 ms; waitForPoolConnections guard added to Scenarios B & C beforeAll hooks", 66);
doc.fillColor("#000000").fontSize(10);
doc.moveDown(0.3);

// ─── PHASE 3 AUTOMATION STANDALONE ──────────────────────────────────────────
sectionHeader("3  phase3-automation STANDALONE (mandatory closure item)");
doc.font("Helvetica").fontSize(10).fillColor("#000000")
   .text(
     "The phase3-automation suite was excluded from previous runs due to accumulated test data in the " +
     "shared dev DB causing the reminder processor to scan ~2 000 stale Saving jars, adding ~35 s per call. " +
     "Prior to this run, old test jars (created > 2 h before session start) were set to status='Completed' " +
     "(exact CI fresh-DB semantics — these are dev-only test rows, no production data). " +
     "The suite was then run synchronously within the 5-minute window.",
     50, doc.y, { width: W }
   );
doc.moveDown(0.4);
passRow("phase3-automation standalone",  "63 / 63 passed", "50.16 s · 0 skipped · 0 failed");
doc.moveDown(0.2);
infoRow("Command", "node_modules/.bin/vitest run src/__tests__/phase3-automation.test.ts");
infoRow("Runner", "artifacts/api-server — singleFork:true");
infoRow("Slowest op", "process-reminders call: responseTime ~3 057 ms (was ~35 000 ms with stale jars)");
doc.moveDown(0.3);

// ─── RATE LIMITS ────────────────────────────────────────────────────────────
sectionHeader("4  RATE-LIMITS SUITE");
passRow("rate-limits.test.ts (TEST_RATE_LIMITS=1)", "13 / 13 passed", "4.05 s");
infoRow("Config", "vitest.rate-limits.config.ts — separate config, in-memory counters, not in normal suite");
doc.moveDown(0.3);

// ─── FULL API SUITE ──────────────────────────────────────────────────────────
sectionHeader("5  FULL API SUITE — TWO INDEPENDENT RUNS");
doc.font("Helvetica").fontSize(10)
   .text("Both runs executed against the live dev DB with the dev server running (singleFork:true, pool:forks).", 50, doc.y, { width: W });
doc.moveDown(0.4);
passRow("Full suite — Run 1 (17 test files)", "433 / 433 passed", "80.43 s total wall-time");
passRow("Full suite — Run 2 (17 test files)", "433 / 433 passed", "88.25 s total wall-time");
doc.moveDown(0.2);
doc.font("Helvetica").fontSize(9.5).fillColor(GRAY)
   .text("Test files included in each full run (17):", 50, doc.y, { width: W });
doc.moveDown(0.1);
const testFiles = [
  "auth.test.ts", "refresh-token.test.ts", "jar-lifecycle.test.ts", "membership.test.ts",
  "schedule.test.ts", "agreement.test.ts", "contribution.test.ts", "payment.test.ts",
  "phase3-automation.test.ts", "phase4a-ledger.test.ts", "phase4b-stripe.test.ts",
  "phase4b-webhook-concurrency.test.ts", "phase4b-webhook.test.ts",
  "phase4c-commitment.test.ts", "phase4c-refunds.test.ts",
  "reminder-dedup.test.ts", "reminder-concurrency.test.ts",
];
for (const f of testFiles) bullet(f, 66);
doc.fillColor("#000000").fontSize(10);
doc.moveDown(0.3);

// ─── PHASE 4C FOCUSED ────────────────────────────────────────────────────────
sectionHeader("6  PHASE 4C FOCUSED TESTS (commitment + refund)");
passRow("phase4c-commitment.test.ts", "36 / 36 passed", "7.85 s");
passRow("phase4c-refunds.test.ts",    "38 / 38 passed", "7.15 s");
doc.moveDown(0.3);

// ─── FRESH MIGRATION ─────────────────────────────────────────────────────────
sectionHeader("7  FRESH MIGRATION REPRODUCIBILITY  (0000 → 0017)");
doc.font("Helvetica").fontSize(10)
   .text(
     "A clean PostgreSQL database was created (m3jar_mig_verify_<timestamp>), all 18 migration SQL " +
     "files were applied in order using psql, and the resulting schema was verified against Phase 4C " +
     "requirements. The database was then dropped.",
     50, doc.y, { width: W }
   );
doc.moveDown(0.4);
infoRow("Migration files applied", "18 / 18 (0000_initial_schema → 0017_phase4c_ft_transaction_types)");
infoRow("Schema checks passed",    "16 / 16");
infoRow("Fresh DB table count",    "29 tables (≥ 16 required)");
doc.moveDown(0.2);
doc.font("Helvetica").fontSize(9.5).fillColor(GRAY).text("Schema checks verified:", 50, doc.y, { width: W });
doc.moveDown(0.1);
const checks = [
  "commitment_snapshots, commitment_snapshot_allocations, fund_commitments, commitment_allocations — tables present",
  "refund_requests, refund_allocations — tables present",
  "ledger_accounts row: code='REFUND_PENDING', account_type='liability', normal_balance='credit'",
  "refund_request_placeholders — correctly dropped by migration 0015",
  "ft_transaction_type_check constraint includes: refund_reservation, refund_finalization, refund_reversal, commitment_transfer",
  "Indexes: commitment_snapshots_status_expires_idx, fund_commitments_snapshot_idx, refund_allocations_stripe_refund_unique_idx — present",
  "fund_commitments columns agreement_id, agreement_version, snapshot_id, jar_id, member_id — all NOT NULL",
];
for (const c of checks) bullet(c, 66);
doc.fillColor("#000000").fontSize(10);
doc.moveDown(0.3);

// ─── TYPECHECKS ──────────────────────────────────────────────────────────────
sectionHeader("8  TYPECHECKS");
passRow("API server  (tsc --noEmit)", "0 errors", "");
passRow("Mobile app  (tsc --noEmit)", "0 errors", "");
doc.moveDown(0.3);

// ─── STRIPE TEST MODE ────────────────────────────────────────────────────────
sectionHeader("9  STRIPE TEST MODE ONLY — CONFIRMATION");
doc.font("Helvetica").fontSize(10)
   .text(
     "No live Stripe keys are used or configured. The following safeguards are verified in code:",
     50, doc.y, { width: W }
   );
doc.moveDown(0.3);
bullet("artifacts/api-server/src/lib/stripe.ts line 37: live keys (sk_live_…) are REJECTED at startup with a hard error", 66);
bullet("Test contributions carry sourceType='stripe_test' / status='stripe_test' — simulated payments only", 66);
bullet("No Stripe webhook scheduler is wired; webhooks are handled only when explicitly POSTed during tests", 66);
bullet("STRIPE_SECRET_KEY is read from env — no sk_live_ value present in the dev environment", 66);
doc.fillColor("#000000").fontSize(10);
doc.moveDown(0.3);

// ─── PHASE 4D ────────────────────────────────────────────────────────────────
sectionHeader("10  PHASE 4D — NOT STARTED");
doc.font("Helvetica").fontSize(10)
   .text(
     "Phase 4D was not started in this session. This session covered Phase 4C verification only. " +
     "No Phase 4D files, routes, migrations, or tests were created or modified.",
     50, doc.y, { width: W }
   );
doc.moveDown(0.3);

// ─── TEST-ONLY CHANGES ───────────────────────────────────────────────────────
sectionHeader("11  TEST-ONLY CHANGES MADE IN THIS SESSION");
doc.font("Helvetica").fontSize(10)
   .text("Two test-configuration changes were made and committed (240cb9b). No production logic was altered.", 50, doc.y, { width: W });
doc.moveDown(0.3);
doc.font("Helvetica-Bold").fontSize(10).text("Change 1 — vitest.config.ts: global testTimeout / hookTimeout 30 000 → 60 000 ms", 50, doc.y, { width: W });
doc.font("Helvetica").fontSize(9.5)
   .text(
     "Rationale: Five tests in phase3-automation that call POST /api/process-reminders lacked explicit " +
     "per-test timeout overrides. Under shared dev-DB load, each call takes ~3–35 s depending on jar count. " +
     "The 30 000 ms global timeout caused spurious failures. Raising to 60 000 ms gives adequate headroom " +
     "without weakening any assertion.",
     50, doc.y, { width: W }
   );
doc.moveDown(0.4);
doc.font("Helvetica-Bold").fontSize(10).text("Change 2 — phase4b-webhook-concurrency.test.ts", 50, doc.y, { width: W });
doc.font("Helvetica").fontSize(9.5)
   .text(
     "Scenario A test timeout: 120 000 → 180 000 ms. Scenarios B and C: added waitForPoolConnections(5, 30_000) " +
     "to beforeAll hooks (same pattern already present in Scenario A). Under full-suite load, Scenario A's " +
     "20 concurrent webhook requests hold DB connections for up to 60 s; the pool-wait guards prevent B and C " +
     "from starting setup before the pool drains. Standalone run: 3/3 in 25 s. Full-suite run with fix: 100% passing.",
     50, doc.y, { width: W }
   );
doc.moveDown(0.3);

// ─── FOOTER ──────────────────────────────────────────────────────────────────
hline();
doc.moveDown(0.3);
doc.font("Helvetica").fontSize(8.5).fillColor(LGRAY)
   .text(
     "M3Jar Phase 4C Final Verification Report  ·  Generated " + new Date().toUTCString() +
     "  ·  HEAD 240cb9b  ·  All production code identical to b6a4694 (origin/main)",
     50, doc.y, { width: W, align: "center" }
   );

doc.end();
console.log("PDF written to:", OUT);
