/**
 * Generates TripJar-Codebase.pdf — a formatted listing of every source file.
 * Run with:  pnpm --filter @workspace/scripts run generate-pdf
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import PDFDocument from "pdfkit";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = path.resolve(__dirname, "../../");
const OUTPUT_PATH = path.join(WORKSPACE_ROOT, "TripJar-Codebase.pdf");

// ─── Files to include ─────────────────────────────────────────────────────────

const INCLUDE_GLOBS: Array<{ dir: string; exts: string[]; label: string }> = [
  { dir: "artifacts/api-server/src",  exts: [".ts"], label: "API Server" },
  { dir: "artifacts/mobile/app",      exts: [".tsx", ".ts"], label: "Mobile — Screens" },
  { dir: "artifacts/mobile/components", exts: [".tsx", ".ts"], label: "Mobile — Components" },
  { dir: "artifacts/mobile/contexts", exts: [".tsx", ".ts"], label: "Mobile — Contexts" },
  { dir: "artifacts/mobile/hooks",    exts: [".tsx", ".ts"], label: "Mobile — Hooks" },
  { dir: "artifacts/mobile/constants", exts: [".ts"], label: "Mobile — Constants" },
  { dir: "lib/db/src",                exts: [".ts"], label: "Database Schema" },
  { dir: "lib/api-client-react/src",  exts: [".ts", ".tsx"], label: "API Client" },
];

const SKIP_PATTERNS = [
  "/node_modules/", "/dist/", "/.pnpm/", "/generated/",
  ".d.ts", ".map", "/.local/",
];

function shouldSkip(filePath: string): boolean {
  return SKIP_PATTERNS.some((p) => filePath.includes(p));
}

function collectFiles(dir: string, exts: string[]): string[] {
  const abs = path.join(WORKSPACE_ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  const results: string[] = [];
  function walk(d: string) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (shouldSkip(full)) continue;
      if (entry.isDirectory()) { walk(full); continue; }
      if (exts.some((e) => entry.name.endsWith(e))) results.push(full);
    }
  }
  walk(abs);
  return results.sort();
}

// ─── PDF generation ───────────────────────────────────────────────────────────

const TITLE_FONT   = "Helvetica-Bold";
const BODY_FONT    = "Courier";
const HEADING_FONT = "Helvetica-Bold";
const SECTION_FONT = "Helvetica";
const FONT_SIZE_CODE    = 7;
const FONT_SIZE_FILE    = 9;
const FONT_SIZE_SECTION = 13;
const FONT_SIZE_TITLE   = 22;
const MARGIN = 50;

const doc = new PDFDocument({ margin: MARGIN, size: "A4", bufferPages: true });
const stream = fs.createWriteStream(OUTPUT_PATH);
doc.pipe(stream);

const PAGE_W = doc.page.width  - MARGIN * 2;
const generated = new Date().toUTCString();

// ── Cover page ──────────────────────────────────────────────────────────────

doc.font(TITLE_FONT).fontSize(28).text("TripJar", { align: "center" });
doc.moveDown(0.3);
doc.font(HEADING_FONT).fontSize(FONT_SIZE_TITLE).fillColor("#555")
   .text("Complete Codebase Report", { align: "center" });
doc.moveDown(0.5);
doc.font(SECTION_FONT).fontSize(10).fillColor("#888")
   .text(`Generated: ${generated}`, { align: "center" });
doc.moveDown(1);

// ── Security sprint summary on cover ──────────────────────────────────────

doc.font(HEADING_FONT).fontSize(12).fillColor("#222")
   .text("Post-Security-Sprint Build", { align: "center" });
doc.moveDown(0.4);

const bullets = [
  "15-minute access tokens with jti nonce + 30-day refresh token rotation",
  "refresh_sessions table — hashed storage, rotation with reuse detection",
  "resetTokenHash — password reset tokens stored as SHA-256 hashes only",
  "Exact-match CORS using new URL().origin Set (no substring matching)",
  "Helmet security headers (CSP, HSTS, X-Frame-Options, etc.)",
  "Zod input validation + middleware factory on all auth routes",
  "Per-endpoint rate limiting (express-rate-limit) — disabled in test mode",
  "Expo SecureStore authentication with proactive token refresh + mutex",
  "67 automated security tests (67 pass, 1 skipped — rate-limit guard)",
];

doc.font(SECTION_FONT).fontSize(9).fillColor("#333");
for (const b of bullets) {
  doc.text(`• ${b}`, { indent: 20 });
}

// ── Table of contents header ────────────────────────────────────────────────

doc.addPage();
doc.font(HEADING_FONT).fontSize(16).fillColor("#111").text("Table of Contents");
doc.moveDown(0.5);

let tocY = doc.y;
const tocEntries: Array<{ label: string; file: string; page: number }> = [];

// ─── Helper: add a section of files ──────────────────────────────────────────

function relPath(abs: string) {
  return abs.replace(WORKSPACE_ROOT + "/", "");
}

function addSection(label: string, files: string[]) {
  if (files.length === 0) return;

  doc.addPage();
  doc.font(HEADING_FONT).fontSize(FONT_SIZE_SECTION).fillColor("#1a1a1a")
     .text(`▸ ${label}`, { underline: false });
  doc.moveDown(0.5);
  doc.moveTo(MARGIN, doc.y).lineTo(MARGIN + PAGE_W, doc.y)
     .strokeColor("#ccc").lineWidth(0.5).stroke();
  doc.moveDown(0.5);

  for (const filePath of files) {
    const rel = relPath(filePath);
    const content = fs.readFileSync(filePath, "utf8");
    const lines = content.split("\n");

    tocEntries.push({ label: rel, file: rel, page: doc.bufferedPageRange().start + doc.bufferedPageRange().count - 1 });

    // File header
    doc.font(HEADING_FONT).fontSize(FONT_SIZE_FILE).fillColor("#003366")
       .text(rel, { continued: false });
    doc.font(SECTION_FONT).fontSize(7).fillColor("#888")
       .text(`${lines.length} lines`, { continued: false });
    doc.moveDown(0.2);

    // Code block
    doc.font(BODY_FONT).fontSize(FONT_SIZE_CODE).fillColor("#111");
    const PAGE_H = doc.page.height - MARGIN * 2;

    for (let i = 0; i < lines.length; i++) {
      const lineNo = String(i + 1).padStart(4, " ");
      const lineText = `${lineNo}  ${lines[i]}`;

      // Check page space
      if (doc.y + FONT_SIZE_CODE * 1.3 > PAGE_H + MARGIN) {
        doc.addPage();
        doc.font(HEADING_FONT).fontSize(7).fillColor("#999")
           .text(`… ${rel} (continued)`, { continued: false });
        doc.font(BODY_FONT).fontSize(FONT_SIZE_CODE).fillColor("#111");
      }

      doc.text(lineText, MARGIN, doc.y, { width: PAGE_W, lineBreak: false });
      doc.moveDown(0.15);
    }

    doc.moveDown(1);
    doc.moveTo(MARGIN, doc.y).lineTo(MARGIN + PAGE_W, doc.y)
       .strokeColor("#eee").lineWidth(0.3).stroke();
    doc.moveDown(0.5);
  }
}

// ─── Render each section ──────────────────────────────────────────────────────

for (const section of INCLUDE_GLOBS) {
  const files = collectFiles(section.dir, section.exts);
  addSection(section.label, files);
}

// Add tests section separately
const testFiles = collectFiles("artifacts/api-server/src/__tests__", [".ts"]);
addSection("Security Tests", testFiles);

// ─── TOC page (now that we know page numbers) ─────────────────────────────────

// The TOC page is page 2 (index 1, 0-based). Write TOC entries retrospectively.
// pdfkit bufferPages lets us go back to a page.
const totalPages = doc.bufferedPageRange().count;

// Switch to TOC page and write entries
const range = doc.bufferedPageRange();
doc.switchToPage(1); // page index 1 = the TOC page we added after cover

doc.y = tocY;
doc.font(BODY_FONT).fontSize(8).fillColor("#333");
for (const entry of tocEntries) {
  const label = entry.file.length > 80 ? "…" + entry.file.slice(-77) : entry.file;
  const pg = String(entry.page + 1).padStart(4, " ");
  if (doc.y > doc.page.height - MARGIN * 2) break; // TOC overflow guard
  doc.text(`${label.padEnd(82, ".")}${pg}`, { lineBreak: false });
  doc.moveDown(0.25);
}

// ─── Page numbers on every page ───────────────────────────────────────────────

for (let i = 0; i < totalPages; i++) {
  doc.switchToPage(i);
  doc.font(SECTION_FONT).fontSize(7).fillColor("#aaa")
     .text(`TripJar Codebase Report — Page ${i + 1} of ${totalPages}`,
       MARGIN, doc.page.height - MARGIN + 5,
       { width: PAGE_W, align: "center" });
}

doc.end();

stream.on("finish", () => {
  const bytes = fs.statSync(OUTPUT_PATH).size;
  console.log(`✅  PDF written to ${OUTPUT_PATH}`);
  console.log(`   Size: ${(bytes / 1024).toFixed(1)} KB`);
  console.log(`   Pages: ~${totalPages}`);
  console.log(`   Download URL: GET /api/download/codebase`);
});

stream.on("error", (err) => {
  console.error("PDF write error:", err);
  process.exit(1);
});
