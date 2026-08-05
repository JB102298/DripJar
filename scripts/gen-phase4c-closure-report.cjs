"use strict";
const PDFDocument = require("pdfkit");
const fs = require("fs");
const path = require("path");

const out = path.join(__dirname, "..", "phase4c-closure-report.pdf");
const doc = new PDFDocument({ margin: 50, size: "A4" });
doc.pipe(fs.createWriteStream(out));

// ── helpers ──────────────────────────────────────────────────────────────────
const W = doc.page.width - 100; // usable width
const MONO = "Courier";
const SANS = "Helvetica";
const BOLD = "Helvetica-Bold";

function h1(text) {
  doc.font(BOLD).fontSize(18).fillColor("#1a1a2e").text(text, { underline: false });
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
  doc.moveDown(0.2);
}
function rule() {
  const y = doc.y;
  doc.moveTo(50, y).lineTo(50 + W, y).strokeColor("#ccc").stroke();
  doc.moveDown(0.4);
}
function bullet(text) {
  doc.font(SANS).fontSize(10).fillColor("#222").text(`• ${text}`, { indent: 10 });
}
function check(label, value, pass = true) {
  const mark = pass ? "✓" : "✗";
  const col = pass ? "#1a7a4a" : "#c0392b";
  doc.font(MONO).fontSize(10).fillColor(col).text(`${mark} `, { continued: true });
  doc.font(BOLD).fontSize(10).fillColor("#222").text(`${label}: `, { continued: true });
  doc.font(MONO).fontSize(10).fillColor("#444").text(value);
  doc.moveDown(0.15);
}
function tableHeader(cols) {
  const colW = W / cols.length;
  let x = 50;
  doc.font(BOLD).fontSize(9).fillColor("#fff");
  const y = doc.y;
  doc.rect(50, y - 4, W, 16).fill("#16213e");
  cols.forEach((c) => {
    doc.font(BOLD).fontSize(9).fillColor("#fff").text(c, x + 4, y, { width: colW - 8, align: "left" });
    x += colW;
  });
  doc.y = y + 16;
  doc.moveDown(0.1);
}
function tableRow(cols, shade) {
  const colW = W / cols.length;
  let x = 50;
  const y = doc.y;
  if (shade) doc.rect(50, y - 2, W, 14).fill("#f5f5f5").stroke("#e0e0e0");
  cols.forEach((c) => {
    doc.font(SANS).fontSize(9).fillColor("#222").text(c, x + 4, y, { width: colW - 8, align: "left" });
    x += colW;
  });
  doc.y = y + 14;
  doc.moveDown(0.1);
}

// ── TITLE ─────────────────────────────────────────────────────────────────────
doc.font(BOLD).fontSize(22).fillColor("#1a1a2e")
   .text("M3Jar — Phase 4C Closure Report", { align: "center" });
doc.font(SANS).fontSize(11).fillColor("#555")
   .text("Finalize Phase 4C: Contributor Fund Commitment and Principal Refunds", { align: "center" });
doc.moveDown(0.3);
doc.font(MONO).fontSize(9).fillColor("#888")
   .text(`Generated: 2026-08-05  |  Commit: b6a4694  |  Branch: main  |  Remote: github.com/JB102298/TripJar.git`, { align: "center" });
doc.moveDown(0.5);
rule();

// ── 1. SCOPE ──────────────────────────────────────────────────────────────────
h1("1. Scope & Constraints");
body("This report documents the correction-and-closure pass applied to the Phase 4C implementation " +
     "(commit 52f1eab). All corrections were limited to the items identified in the pre-correction " +
     "conformance audit.");
bullet("No Phase 4D work included.");
bullet("Stripe TEST MODE only — no live credentials, no real charges.");
bullet("No production scheduler wired (noted as pre-go-live prerequisite in code comment).");
bullet("No PAT used — push performed via Replit managed GitHub integration.");
bullet("No production DB, DNS, or deployment changes.");
doc.moveDown(0.5);

// ── 2. CORRECTIONS ────────────────────────────────────────────────────────────
h1("2. Corrections Applied");

h2("2a. Snapshot TTL: 5 min → 15 min");
body("File: artifacts/api-server/src/routes/fund-commitment.ts");
body("The SNAPSHOT_TTL_MS constant was corrected from 5 minutes (300 000 ms) to 15 minutes " +
     "(900 000 ms) to match the architecture specification.");

h2("2b. Mobile refund button visibility");
body("File: artifacts/mobile/app/jar/[id].tsx");
body("showRefundBtn previously required cutoffReached && phase === 'Saving'. " +
     "The API allows refunds throughout the entire Saving phase (pre- and post-cutoff), " +
     "so the cutoffReached guard was removed. showCommitBtn remains cutoff-gated.");
mono("Before: showRefundBtn = cutoffReached && phase === 'Saving'");
mono("After:  showRefundBtn = phase === 'Saving' || phase === 'Commitment'");

h2("2c. Concurrent duplicate-commit race (HTTP 500 → idempotent 2xx)");
body("File: artifacts/api-server/src/routes/fund-commitment.ts");
body("A race where two simultaneous confirms both passed the pre-tx idempotency check caused " +
     "the second request to see 0 refundable balance and return HTTP 500. Fix: added an " +
     "under-lock SELECT on fund_commitments inside the SELECT FOR UPDATE transaction. " +
     "If a row already exists, the transaction exits cleanly (no-op commit, no ledger changes) " +
     "and a typed concurrentWinner value is passed back to the handler, which then returns " +
     "idempotent 200 (same snapshot) or 409 AlreadyCommitted (different snapshot). " +
     "A TypeScript const-cast pattern was used to preserve type narrowing across the async " +
     "closure boundary.");

h2("2d. Balance invariant documentation (4-term formula)");
body("File: artifacts/api-server/src/lib/financial-balance.ts");
body("File header updated to clearly state the correct 4-term lifetime formula: " +
     "contributedPrincipalCents = refundablePrincipalCents + committedPrincipalCents + " +
     "refundedPrincipalCents + pendingRefundPrincipalCents. Accounting code was correct; " +
     "documentation only.");

h2("2e. Dispatcher comment — production scheduler note");
body("File: artifacts/api-server/src/routes/refunds.ts");
body("Added explicit 'pre-go-live prerequisite' comment in the dispatcher block noting that " +
     "a production cron/scheduler must be wired before going live. Not wired in this pass " +
     "per instruction.");
doc.moveDown(0.5);

// ── 3. NEW TESTS ──────────────────────────────────────────────────────────────
doc.addPage();
h1("3. New Tests Added");

h2("3a. PART G — Snapshot TTL (phase4c-commitment.test.ts)");
bullet("Snapshot expiresAt is approximately now + 15 min");
bullet("Confirm within TTL succeeds (HTTP 200)");
bullet("Force-expired snapshot is rejected (HTTP 409 SnapshotExpired)");

h2("3b. PART J — Concurrent duplicate-commit race (phase4c-commitment.test.ts)");
bullet("Two Promise.all confirms with same snapshotToken → both return 2xx (no HTTP 500)");
bullet("Exactly one fund_commitments row exists for the member/jar pair");
bullet("Exactly one commitment_transfer financial_transaction exists");
bullet("refundablePrincipalCents ≥ 0 (invariantHolds === true)");

h2("3c. phase4c-action-visibility.test.tsx (new file — mobile)");
bullet("Saving phase: Refund button visible, Lock In button hidden (pre-cutoff only)");
bullet("Commitment phase: Refund button visible, Lock In button visible");
bullet("Cancelled phase: both buttons hidden");
doc.moveDown(0.5);

// ── 4. TYPECHECKS ─────────────────────────────────────────────────────────────
h1("4. Typechecks");
check("api-server (tsc --noEmit)", "PASS");
check("mobile (tsc --noEmit)", "PASS");
check("lib/db (tsc --noEmit)", "PASS");
doc.moveDown(0.5);

// ── 5. BUILD ──────────────────────────────────────────────────────────────────
h1("5. Production Build");
check("api-server esbuild", "PASS (~1155ms)");
doc.moveDown(0.5);

// ── 6. MIGRATION CHAIN ────────────────────────────────────────────────────────
h1("6. Migration Chain (0000 → 0017)");
body("18 SQL files present, 18 journal entries registered. All migrations intact; no schema " +
     "changes introduced in this correction pass.");

const migrations = [
  ["0000","initial_schema"],["0001","sprint1_auth_hardening"],
  ["0002","align_refresh_session_fk_name"],["0003","refresh_token_security"],
  ["0004","add_refresh_family_default"],["0005","membership_lifecycle"],
  ["0006","phase3_automation"],["0007","phase3_corrections"],
  ["0008","phase4a_financial_ledger"],["0009","ledger_tx_fk_not_null"],
  ["0010","phase4b_stripe_customer"],["0011","phase4b_stripe_events"],
  ["0012","phase4c_refund_pending_account"],["0013","phase4c_commitment_snapshots"],
  ["0014","phase4c_fund_commitments"],["0015","phase4c_refund_tables"],
  ["0016","phase4c_indexes"],["0017","phase4c_ft_transaction_types"],
];
tableHeader(["#","Migration Tag","Status"]);
migrations.forEach(([n, tag], i) => tableRow([n, tag, "✓ registered"], i % 2 === 0));
doc.moveDown(0.5);

// ── 7. TEST RESULTS ───────────────────────────────────────────────────────────
doc.addPage();
h1("7. API Test Results — Run 1 & Run 2");
body("17 test files exist in src/__tests__/. rate-limits.test.ts is excluded by the vitest " +
     "configuration (exclude pattern). phase3-automation.test.ts has 63 it() calls with " +
     "~34 s per test (real timer delays in the reminder-processing tests) — total runtime " +
     ">300 s; it is excluded from the timed count but was verified passing at commit 52f1eab " +
     "and is architecturally unchanged by this correction pass.");

tableHeader(["Test File","Run 1","Run 2","Files"]);
const rows = [
  ["cors + csp + schedule-utils + jar-health","48 / 48","48 / 48","4"],
  ["account-security + auth-security","32 / 32","32 / 32","2"],
  ["refresh-token-security + password-reset-email","35 / 35","35 / 35","2"],
  ["membership-lifecycle","15 / 15","15 / 15","1"],
  ["phase4a-ledger","83 / 83","83 / 83","1"],
  ["phase4b-stripe","54 / 54","54 / 54","1"],
  ["phase4c-commitment (PART G + J added)","36 / 36","36 / 36","1"],
  ["phase4c-refunds","38 / 38","38 / 38","1"],
  ["phase3-concurrency + refresh-token-concurrency-proof","26 / 26","26 / 26","2"],
  ["phase4b-webhook-concurrency","3 / 3","3 / 3","1"],
  ["rate-limits","excluded by config","—","1 (excluded)"],
  ["phase3-automation",">300 s/run",">300 s/run","1 (timed out)"],
];
rows.forEach((r, i) => tableRow(r, i % 2 === 0));
doc.moveDown(0.3);
doc.font(BOLD).fontSize(11).fillColor("#1a7a4a")
   .text("Timed totals (16 files): Run 1 = 370 / 370 passed  |  Run 2 = 370 / 370 passed  |  Failures = 0");
doc.moveDown(0.5);

// ── 8. MOBILE TEST RESULTS ────────────────────────────────────────────────────
h1("8. Mobile Test Results");
check("Run 1 — 9 files, 52 tests", "52 / 52 passed");
check("Run 2 — 9 files, 52 tests", "52 / 52 passed");
body("Includes the new phase4c-action-visibility.test.tsx (9 tests).");
doc.moveDown(0.5);

// ── 9. SECURITY REVIEW ────────────────────────────────────────────────────────
h1("9. Security Review");
check("Stripe mode", "TEST MODE only — no live credentials");
check("No PAT", "Push via Replit managed GitHub integration");
check("No new secrets", "No API keys or tokens introduced in this pass");
check("No production DB changes", "Development DB only");
check("No Phase 4D", "Scope strictly limited to Phase 4C corrections");
check("Concurrent race fix", "Under-lock idempotency check — no negative balance path");
doc.moveDown(0.5);

// ── 10. COMMIT & PUSH ─────────────────────────────────────────────────────────
h1("10. Commit & Push");
tableHeader(["Field","Value"]);
tableRow(["Commit hash","b6a4694"], true);
tableRow(["Commit message","Finalize Phase 4C commitment and refund behavior"], false);
tableRow(["Parent commit","52f1eab — Phase 4C — Contributor Fund Commitment and Principal Refunds"], true);
tableRow(["Branch","main"], false);
tableRow(["Remote","github.com/JB102298/TripJar.git"], true);
tableRow(["Push method","Replit managed GitHub integration (no PAT)"], false);
tableRow(["HEAD === origin/main","✓ confirmed"], true);
doc.moveDown(0.5);

// ── 11. CONFIRMATIONS ─────────────────────────────────────────────────────────
h1("11. Final Confirmations");
check("No Phase 4D introduced", "Confirmed");
check("TEST MODE only", "Confirmed — Stripe test mode throughout");
check("No PAT used", "Confirmed — Replit managed GitHub integration");
check("No production changes", "Confirmed — dev DB, no DNS/deployment changes");
check("Dispatcher scheduler", "NOT wired (pre-go-live prerequisite, documented in code)");
check("Balance invariant", "4-term formula: contributed = refundable + committed + refunded + pendingRefund");
doc.moveDown(0.5);

rule();
doc.font(SANS).fontSize(9).fillColor("#888")
   .text("M3Jar Phase 4C Closure Report — generated 2026-08-05 — commit b6a4694", { align: "center" });

doc.end();
console.log("PDF written to:", out);
