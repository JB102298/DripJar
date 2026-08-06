"use strict";
const PDFDocument = require("pdfkit");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const OUT = path.resolve(__dirname, "../dripjar-full-rebrand-report.pdf");
const doc = new PDFDocument({ margin: 50, size: "LETTER" });
doc.pipe(fs.createWriteStream(OUT));

const GREEN = "#178B57";
const DARK  = "#111827";
const GREY  = "#6B7280";
const LGREY = "#F3F4F6";

let commitHash = "unknown";
try { commitHash = execSync("git rev-parse --short HEAD").toString().trim(); } catch {}
const generatedAt = new Date().toISOString();

// ── Helpers ──────────────────────────────────────────────────────────────────
function header(text) {
  doc.moveDown(0.5)
     .font("Helvetica-Bold").fontSize(14).fillColor(GREEN)
     .text(text, { underline: false })
     .moveDown(0.3)
     .font("Helvetica").fontSize(10).fillColor(DARK);
}

function subheader(text) {
  doc.moveDown(0.3)
     .font("Helvetica-Bold").fontSize(11).fillColor(DARK)
     .text(text)
     .moveDown(0.2)
     .font("Helvetica").fontSize(10).fillColor(DARK);
}

function para(text) {
  doc.font("Helvetica").fontSize(10).fillColor(DARK)
     .text(text, { lineGap: 3 })
     .moveDown(0.3);
}

function bullet(items) {
  for (const item of items) {
    doc.font("Helvetica").fontSize(10).fillColor(DARK)
       .text(`• ${item}`, { indent: 16, lineGap: 2 });
  }
  doc.moveDown(0.3);
}

function tableRow(cols, widths, isBold, fillBg) {
  const startX = doc.page.margins.left;
  const startY = doc.y;
  if (fillBg) {
    doc.rect(startX - 4, startY - 2, widths.reduce((a, b) => a + b, 0) + 8, 16).fill(LGREY).fillColor(DARK);
  }
  let x = startX;
  const font = isBold ? "Helvetica-Bold" : "Helvetica";
  for (let i = 0; i < cols.length; i++) {
    doc.font(font).fontSize(9).fillColor(DARK)
       .text(cols[i], x, startY, { width: widths[i] - 4, lineBreak: false });
    x += widths[i];
  }
  doc.y = startY + 14;
}

// ── Cover Page ────────────────────────────────────────────────────────────────
doc.rect(0, 0, doc.page.width, 220).fill(GREEN);
doc.font("Helvetica-Bold").fontSize(38).fillColor("#FFFFFF")
   .text("🫙 DripJar", 50, 70, { align: "center" });
doc.font("Helvetica-Bold").fontSize(20).fillColor("#E8F6EF")
   .text("Full Rebrand Report", { align: "center" });
doc.font("Helvetica").fontSize(12).fillColor("#B7DFCB")
   .text("M3Jar → DripJar", { align: "center" });
doc.y = 240;
doc.font("Helvetica").fontSize(10).fillColor(GREY)
   .text(`Commit: ${commitHash}   |   Generated: ${generatedAt}`, { align: "center" });
doc.moveDown(1.5);

// ── Executive Summary ─────────────────────────────────────────────────────────
header("Executive Summary");
para(
  "This report documents the complete rebrand of the collaborative savings platform from " +
  '"M3Jar" to "DripJar". The rebrand was executed in a single atomic commit titled ' +
  '"Rebrand M3Jar to DripJar". All customer-facing strings, email templates, API descriptions, ' +
  "mobile UI copy, seed data, and documentation were updated. Internal AsyncStorage key names and " +
  "migration test database names were intentionally preserved. A new automated brand guard test " +
  "(brand-guard.test.ts) is now part of the CI suite and will catch any reintroduction of legacy " +
  "brand names into active source code."
);

// ── Validation Results ────────────────────────────────────────────────────────
header("Validation Results");
tableRow(["Suite", "Files", "Tests", "Status"], [200, 80, 80, 120], true, true);
tableRow(["API Server (run 1)", "20", "754", "✅ PASS"], [200, 80, 80, 120], false, false);
tableRow(["API Server (run 2)", "20", "754", "✅ PASS"], [200, 80, 80, 120], false, true);
tableRow(["Mobile (run 1)", "10", "81", "✅ PASS"], [200, 80, 80, 120], false, false);
tableRow(["Mobile (run 2)", "10", "81", "✅ PASS"], [200, 80, 80, 120], false, true);
tableRow(["API Typecheck", "—", "—", "✅ CLEAN"], [200, 80, 80, 120], false, false);
tableRow(["Mobile Typecheck", "—", "—", "✅ CLEAN"], [200, 80, 80, 120], false, true);
tableRow(["DB Lib Typecheck", "—", "—", "✅ CLEAN"], [200, 80, 80, 120], false, false);
tableRow(["API Production Build", "—", "—", "✅ CLEAN"], [200, 80, 80, 120], false, true);
tableRow(["Brand Guard (new test)", "148 scanned", "pass", "✅ PASS"], [200, 80, 80, 120], false, false);
doc.moveDown(0.5);

// ── Files Changed ─────────────────────────────────────────────────────────────
header("Files Changed — Class A (Must Change)");
subheader("API Server — Lib & Routes");
bullet([
  "artifacts/api-server/src/lib/email.ts — All email templates, subjects, sender fallback, base-URL fallback updated to thedripjar.com",
  "artifacts/api-server/src/lib/reminder-email.ts — Header, footer, plain-text sign-offs in all 6 reminder email types",
  "artifacts/api-server/src/routes/jars.ts — DEFAULT_AGREEMENT_TEXT (3 occurrences)",
  "artifacts/api-server/src/routes/invitations.ts — Fallback inviter name string",
]);

subheader("API Server — Tests");
bullet([
  "artifacts/api-server/src/__tests__/cors.test.ts — Test fixtures updated from m3jar.com → thedripjar.com",
  "artifacts/api-server/src/__tests__/password-reset-email.test.ts — All fallback assertions updated",
]);

subheader("Mobile App");
bullet([
  "artifacts/mobile/app/(auth)/index.tsx — Welcome screen brand name",
  "artifacts/mobile/app/(auth)/login.tsx — Login screen brand name",
  "artifacts/mobile/app/(auth)/register.tsx — Register screen brand name + Terms of Service line",
  "artifacts/mobile/app/reset-password/[token].tsx — 'DripJar account' copy",
]);

subheader("API Spec & Generated Client");
bullet([
  "lib/api-spec/openapi.yaml — description field",
  "lib/api-client-react/src/generated/api.ts — Generated comment",
  "lib/api-client-react/src/generated/api.schemas.ts — Generated comment",
]);

subheader("Documentation");
bullet([
  "README.md — Full rewrite under DripJar; historical note preserved",
  "replit.md — Full rewrite; seed email examples, PDF name, gotcha notes updated",
]);

subheader("Seed & Scripts");
bullet([
  "scripts/src/seed.ts — Label, 5 @m3jar.dev → @dripjar.dev emails, AGREEMENT_TEXT",
  "scripts/src/generate-codebase-pdf.ts — Output filename, cover title, footer, log message",
]);

header("Files Changed — Class B (Should Change)");
bullet([
  "artifacts/api-server/src/routes/download.ts — PDF const/path (M3Jar-Codebase.pdf → DripJar-Codebase.pdf)",
  "artifacts/mobile/app.json — name, slug, scheme updated; bundleIdentifier/package left (owner action)",
  "artifacts/mobile/scripts/build.js — Comment example domain updated",
]);

header("New File Added — Brand Guard");
bullet([
  "artifacts/api-server/src/__tests__/brand-guard.test.ts — Scans 148 active source files for M3Jar/TripJar/m3jar.com/@m3jar.dev patterns; any regression fails CI",
]);

// ── Intentionally Preserved ───────────────────────────────────────────────────
header("Intentionally Preserved (Class C — Leave)");
subheader("Internal / Not Customer-Visible");
bullet([
  "artifacts/mobile/contexts/auth-context.tsx — AsyncStorage keys (tripjar_access_token, tripjar_refresh_token): internal only; changing them would silently log out all users",
  "artifacts/mobile/__tests__/auth-context.test.tsx — References those same key constants",
  "scripts/run-fresh-migration.cjs / .mjs — Dev test database names (m3jar_migration_verify_*): not customer-visible",
  "scripts/verify-fresh-migration.sh — Same internal dev DB references",
  "lib/db/drizzle/*.sql — Historical migration files: immutable by design",
  "Old closure report PDFs — Historical artifacts from prior phases",
]);

subheader("Historical Notes in Documentation (Intentional)");
bullet([
  "README.md — 'DripJar was previously developed under the working names M3Jar and TripJar.'",
  "replit.md — Same historical note; gotcha entry explaining bundleIdentifier still reads com.m3jar.app",
]);

// ── Owner Actions Required ────────────────────────────────────────────────────
header("Owner Actions Required (Not Automated)");
tableRow(["Action", "Detail"], [220, 330], true, true);
tableRow(["Resend sending domain", "Add updates.thedripjar.com; verify DNS; update EMAIL_FROM env var. Do NOT remove m3jar.com until new domain is verified."], [220, 330], false, false);
doc.moveDown(0.5);
tableRow(["GitHub repo rename", "Rename JB102298/TripJar → JB102298/DripJar in GitHub Settings → General → Repository name"], [220, 330], false, true);
doc.moveDown(0.5);
tableRow(["APP_BASE_URL env var", "Set to https://TheDripJar.com in production (Replit Secrets)"], [220, 330], false, false);
doc.moveDown(0.5);
tableRow(["ALLOWED_ORIGINS env var", "Add https://thedripjar.com,https://www.thedripjar.com"], [220, 330], false, true);
doc.moveDown(0.5);
tableRow(["bundleIdentifier / package", "Change com.m3jar.app → com.dripjar.app in artifacts/mobile/app.json BEFORE any App Store / Play Store submission"], [220, 330], false, false);
doc.moveDown(0.5);
tableRow(["Stripe Dashboard", "Update business/public branding from M3Jar to DripJar (test mode; manual UI)"], [220, 330], false, true);
doc.moveDown(0.5);
tableRow(["Replit display name", "Update project display name to DripJar in Replit UI settings"], [220, 330], false, false);
doc.moveDown(0.5);

// ── Git ───────────────────────────────────────────────────────────────────────
header("Commit & Push");
bullet([
  `Commit: "${commitHash}" — "Rebrand M3Jar to DripJar"`,
  "22 files changed, 248 insertions(+), 114 deletions(-)",
  "1 new file: artifacts/api-server/src/__tests__/brand-guard.test.ts",
  "Pushed to JB102298/TripJar:main via Replit GitHub integration",
]);

// ── Brand Guard Coverage ──────────────────────────────────────────────────────
header("Brand Guard — Whitelisted Scan Directories");
bullet([
  "artifacts/api-server/src",
  "artifacts/mobile/app",
  "artifacts/mobile/hooks",
  "artifacts/mobile/contexts",
  "artifacts/mobile/components",
  "lib/api-spec",
  "scripts/src",
]);
para("148 source files scanned. 2 pattern classes checked: LEGACY_EXACT [M3Jar, TripJar] and LEGACY_CI [m3jar.com, @m3jar.dev, updates.m3jar.com]. All pass.");

// ── Finalize ──────────────────────────────────────────────────────────────────
doc.moveDown(1);
doc.font("Helvetica-Oblique").fontSize(9).fillColor(GREY)
   .text(
     `DripJar Full Rebrand Report  •  commit ${commitHash}  •  generated ${generatedAt}`,
     { align: "center" }
   );

doc.end();
console.log("✅  dripjar-full-rebrand-report.pdf written →", OUT);
