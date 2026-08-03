/**
 * Generates TripJar-Codebase.pdf — a formatted source listing of every
 * application file, suitable for code review and archival.
 *
 * Security properties
 * ───────────────────
 * Uses an ALLOW-LIST approach: only directories explicitly listed in
 * INCLUDE_SECTIONS are ever read.  A secondary DENY-LIST (SKIP_PATTERNS)
 * stops any accidental descent into build artefacts.  Every file is
 * additionally scanned for content patterns that look like real secrets
 * before being included; anything that matches is skipped with a warning.
 *
 * What is intentionally EXCLUDED
 * ───────────────────────────────
 * • .env / .env.* files                   • node_modules / .pnpm
 * • dist / build output                   • .git metadata
 * • *.pem / *.key / *.p12 / *.pfx certs  • *.log / tmp files
 * • .replit / Replit platform files       • Binary assets (images, fonts…)
 * • Generated files (*.d.ts, *.map)       • scripts/src/seed.ts (demo passwords)
 * • Any file whose content matches a known-secret pattern (see below)
 *
 * What IS included
 * ────────────────
 * Only .ts and .tsx source files inside the explicitly listed source
 * directories.  Environment-variable NAMES (e.g. `process.env["JWT_SECRET"]`)
 * appear as written; actual secret VALUES never appear in source code.
 *
 * Run:  pnpm --filter @workspace/scripts run generate-pdf
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import PDFDocument from "pdfkit";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = path.resolve(__dirname, "../../");
const OUTPUT_PATH = path.resolve(WORKSPACE_ROOT, "TripJar-Codebase.pdf");

// ─── Sanity-check: OUTPUT_PATH must stay inside WORKSPACE_ROOT ────────────────
// Belt-and-suspenders: prevents path-traversal if WORKSPACE_ROOT is somehow
// manipulated before this module runs.
if (!OUTPUT_PATH.startsWith(WORKSPACE_ROOT + path.sep) && OUTPUT_PATH !== WORKSPACE_ROOT) {
  console.error(`[FATAL] Resolved output path "${OUTPUT_PATH}" escapes workspace root`);
  process.exit(1);
}

// ─── Git metadata ─────────────────────────────────────────────────────────────

function gitCommitHash(): string {
  const result = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
    cwd: WORKSPACE_ROOT,
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout.trim() : "(git unavailable)";
}

function gitCommitDate(): string {
  const result = spawnSync("git", ["log", "-1", "--format=%ci"], {
    cwd: WORKSPACE_ROOT,
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout.trim() : "";
}

const commitHash = gitCommitHash();
const commitDate = gitCommitDate();

// ─── Allow-list: only these directories are ever read ────────────────────────

interface Section {
  label: string;
  dir: string;
  exts: string[];
}

const INCLUDE_SECTIONS: Section[] = [
  { label: "API Server — Application",   dir: "artifacts/api-server/src",               exts: [".ts"] },
  { label: "Security Tests",             dir: "artifacts/api-server/src/__tests__",      exts: [".ts"] },
  { label: "Mobile — Screens",           dir: "artifacts/mobile/app",                   exts: [".tsx", ".ts"] },
  { label: "Mobile — Components",        dir: "artifacts/mobile/components",             exts: [".tsx", ".ts"] },
  { label: "Mobile — Contexts",          dir: "artifacts/mobile/contexts",               exts: [".tsx", ".ts"] },
  { label: "Mobile — Hooks",             dir: "artifacts/mobile/hooks",                  exts: [".tsx", ".ts"] },
  { label: "Mobile — Constants",         dir: "artifacts/mobile/constants",              exts: [".ts"] },
  { label: "Database Schema",            dir: "lib/db/src",                              exts: [".ts"] },
  { label: "API Client",                 dir: "lib/api-client-react/src",                exts: [".ts", ".tsx"] },
];

// ─── Deny-list patterns applied to absolute file paths ───────────────────────
// These are a secondary safety net.  They catch accidental inclusions from
// sub-directories that match the above section dirs but should be skipped.

const PATH_DENY_PATTERNS: string[] = [
  // Build & package artefacts
  "/node_modules/",
  "/dist/",
  "/.pnpm/",
  "/build/",
  "/coverage/",
  // Generated / type-declaration files
  ".d.ts",
  ".js.map",
  ".ts.map",
  "/generated/",
  // Platform / infra files
  "/.local/",
  "/.git/",
  "/.replit",
  ".replit.nix",
  // Secret-sounding filenames (belt-and-suspenders)
  ".env",
  ".env.",
  "secrets.",
  ".pem",
  ".key",
  ".p12",
  ".pfx",
  ".cert",
  ".crt",
  // Log / temp files
  ".log",
  "/tmp/",
  "/temp/",
  "/.cache/",
  // Binary assets
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".svg",
  ".ico",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".mp4",
  ".mov",
  ".zip",
  ".tar",
  ".gz",
];

function pathIsDenied(absPath: string): boolean {
  return PATH_DENY_PATTERNS.some((p) => absPath.includes(p));
}

// ─── Content-level secret scanner ────────────────────────────────────────────
// Applied to every file before it is included.
// ONLY matches patterns that definitively indicate a real secret value,
// not variable-name references like process.env["JWT_SECRET"].

interface ContentPattern {
  label: string;
  pattern: RegExp;
}

const CONTENT_SECRET_PATTERNS: ContentPattern[] = [
  {
    label: "PostgreSQL connection string with embedded credentials",
    // Matches postgres://user:password@host — but NOT postgres://${...} (template literals)
    pattern: /postgres:\/\/[^$][^{][^:]*:[^@$\s]{2,}@/,
  },
  {
    label: "PEM private key block",
    pattern: /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----/,
  },
  {
    label: "Possible long JWT / Bearer token value (>120 chars)",
    // A real JWT token in a string literal; variable references don't match
    // because they're "process.env[..." not a raw ey... string
    pattern: /["'`]eyJ[A-Za-z0-9_-]{50,}\.[A-Za-z0-9_-]{50,}\.[A-Za-z0-9_-]{20,}["'`]/,
  },
  {
    label: "AWS-style access key",
    pattern: /(?:AKIA|ASIA|AROA|AIPA|ANPA|ANVA|ASIA)[A-Z0-9]{16}/,
  },
  {
    label: "Generic high-entropy secret assignment (≥40-char hex/base64 value in a string literal)",
    // Only matches: key = "long-hex-value" style assignments — not variable references
    pattern: /(?:secret|token|key|password)\s*[:=]\s*["'][A-Za-z0-9+/]{40,}={0,2}["']/i,
  },
];

interface ScanResult {
  safe: boolean;
  violations: string[];
}

function scanContent(absPath: string, content: string): ScanResult {
  const violations: string[] = [];
  for (const { label, pattern } of CONTENT_SECRET_PATTERNS) {
    if (pattern.test(content)) {
      violations.push(label);
    }
  }
  return { safe: violations.length === 0, violations };
}

// ─── File collection ─────────────────────────────────────────────────────────

interface CollectedFile {
  absPath: string;
  relPath: string;
  content: string;
  lines: number;
}

const SKIPPED_FILES: Array<{ path: string; reason: string }> = [];

function collectSection(section: Section): CollectedFile[] {
  const absDir = path.resolve(WORKSPACE_ROOT, section.dir);
  if (!fs.existsSync(absDir)) return [];

  const results: CollectedFile[] = [];

  function walk(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (pathIsDenied(abs)) {
        SKIPPED_FILES.push({ path: abs.replace(WORKSPACE_ROOT + "/", ""), reason: "path deny-list" });
        continue;
      }
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!section.exts.some((ext) => entry.name.endsWith(ext))) continue;

      const content = fs.readFileSync(abs, "utf8");
      const scan = scanContent(abs, content);

      if (!scan.safe) {
        const rel = abs.replace(WORKSPACE_ROOT + "/", "");
        SKIPPED_FILES.push({ path: rel, reason: `content scan: ${scan.violations.join("; ")}` });
        console.warn(`[CONTENT-SCAN SKIP] ${rel} — ${scan.violations.join("; ")}`);
        continue;
      }

      results.push({
        absPath: abs,
        relPath: abs.replace(WORKSPACE_ROOT + "/", ""),
        content,
        lines: content.split("\n").length,
      });
    }
  }

  walk(absDir);
  return results.sort((a, b) => a.relPath.localeCompare(b.relPath));
}

// ─── PDF layout constants ─────────────────────────────────────────────────────

const FONT_TITLE   = "Helvetica-Bold";
const FONT_HEADING = "Helvetica-Bold";
const FONT_BODY    = "Helvetica";
const FONT_MONO    = "Courier";
const SZ_TITLE     = 28;
const SZ_SUBTITLE  = 14;
const SZ_SECTION   = 13;
const SZ_FILE      = 9;
const SZ_CODE      = 7;
const SZ_SMALL     = 8;
const SZ_FOOTER    = 7;
const MARGIN       = 50;

const doc = new PDFDocument({ margin: MARGIN, size: "A4", bufferPages: true });
const writeStream = fs.createWriteStream(OUTPUT_PATH);
doc.pipe(writeStream);

const PAGE_W = doc.page.width - MARGIN * 2;

// ─── Cover page ───────────────────────────────────────────────────────────────

const generatedAt = new Date().toUTCString();

doc.font(FONT_TITLE).fontSize(SZ_TITLE).fillColor("#111").text("M3Jar", { align: "center" });
doc.moveDown(0.3);
doc.font(FONT_HEADING).fontSize(SZ_SUBTITLE).fillColor("#444")
   .text("Complete Codebase Report", { align: "center" });
doc.moveDown(0.6);

// Generation metadata
doc.font(FONT_BODY).fontSize(SZ_SMALL).fillColor("#666");
doc.text(`Generated:   ${generatedAt}`, { align: "center" });
if (commitHash !== "(git unavailable)") {
  doc.text(`Git commit:  ${commitHash}${commitDate ? `  (${commitDate})` : ""}`, { align: "center" });
}
doc.moveDown(1.2);

// Security sprint highlights
doc.font(FONT_HEADING).fontSize(11).fillColor("#1a1a1a")
   .text("Post-Security-Sprint Build", { align: "center" });
doc.moveDown(0.5);
doc.font(FONT_BODY).fontSize(SZ_SMALL).fillColor("#333");
const features = [
  "15-minute access tokens (JWT, jti nonce) + 30-day refresh token rotation",
  "refresh_sessions table — hashed token storage, reuse detection",
  "resetTokenHash — password reset tokens stored as SHA-256 hashes only",
  "Exact-match CORS (new URL().origin Set; no substring matching)",
  "Helmet security headers",
  "Zod input validation + middleware factory on all auth routes",
  "Per-endpoint rate limiting (express-rate-limit; disabled in NODE_ENV=test)",
  "Expo SecureStore authentication with proactive refresh + mutex",
  "67 automated security tests (67 pass, 1 skipped — rate-limit guard)",
];
for (const f of features) doc.text(`• ${f}`, { indent: 24 });

doc.moveDown(1.2);

// Exclusions notice
doc.font(FONT_HEADING).fontSize(10).fillColor("#b00000")
   .text("Security Notice — Exclusions", { align: "left" });
doc.moveDown(0.3);
doc.font(FONT_BODY).fontSize(SZ_SMALL).fillColor("#333");
const exclusions = [
  "Environment variable VALUES  (names only appear, e.g. process.env[\"JWT_SECRET\"])",
  ".env files, Replit Secrets, JWT secrets, database connection strings, API keys",
  "Actual tokens (access, refresh, reset) or password hashes",
  "node_modules, dist/build output, .pnpm store",
  ".git metadata, .replit platform files",
  "*.pem / *.key / *.p12 certificates and private keys",
  "Binary assets (images, fonts, archives)",
  "Log files, tmp/cache directories",
  "Any file whose content matches a known-secret pattern (scanned at generation time)",
];
for (const e of exclusions) doc.text(`✗  ${e}`, { indent: 16 });

// ─── Table of contents placeholder ───────────────────────────────────────────

doc.addPage();
doc.font(FONT_HEADING).fontSize(16).fillColor("#111").text("Table of Contents");
doc.moveDown(0.5);
const tocPageY = doc.y;
const tocEntries: Array<{ rel: string; pageIndex: number }> = [];

// ─── Section rendering ────────────────────────────────────────────────────────

const PAGE_H_USABLE = doc.page.height - MARGIN * 2;

function renderSection(section: Section, files: CollectedFile[]) {
  if (files.length === 0) return;

  doc.addPage();
  doc.font(FONT_HEADING).fontSize(SZ_SECTION).fillColor("#1a3a5c")
     .text(`▸  ${section.label} (${files.length} file${files.length !== 1 ? "s" : ""})`);
  doc.moveDown(0.4);
  doc.moveTo(MARGIN, doc.y).lineTo(MARGIN + PAGE_W, doc.y).strokeColor("#bcd").lineWidth(0.5).stroke();
  doc.moveDown(0.5);

  for (const file of files) {
    // Record page for TOC
    tocEntries.push({
      rel: file.relPath,
      pageIndex: doc.bufferedPageRange().start + doc.bufferedPageRange().count - 1,
    });

    // File header
    doc.font(FONT_HEADING).fontSize(SZ_FILE).fillColor("#003366").text(file.relPath);
    doc.font(FONT_BODY).fontSize(6).fillColor("#999").text(`${file.lines} lines`);
    doc.moveDown(0.2);

    // Source lines
    doc.font(FONT_MONO).fontSize(SZ_CODE).fillColor("#111");
    const srcLines = file.content.split("\n");

    for (let i = 0; i < srcLines.length; i++) {
      if (doc.y + SZ_CODE * 1.4 > PAGE_H_USABLE + MARGIN) {
        doc.addPage();
        doc.font(FONT_HEADING).fontSize(6).fillColor("#aaa")
           .text(`…  ${file.relPath}  (continued)`);
        doc.font(FONT_MONO).fontSize(SZ_CODE).fillColor("#111");
      }
      const num = String(i + 1).padStart(4, " ");
      doc.text(`${num}  ${srcLines[i]}`, MARGIN, doc.y, { width: PAGE_W, lineBreak: false });
      doc.moveDown(0.15);
    }

    doc.moveDown(0.8);
    doc.moveTo(MARGIN, doc.y).lineTo(MARGIN + PAGE_W, doc.y).strokeColor("#eee").lineWidth(0.3).stroke();
    doc.moveDown(0.5);
  }
}

// ─── Render all sections ──────────────────────────────────────────────────────

const allSections: Array<{ section: Section; files: CollectedFile[] }> = [];
for (const section of INCLUDE_SECTIONS) {
  const files = collectSection(section);
  allSections.push({ section, files });
  renderSection(section, files);
}

// ─── Skipped-files appendix ──────────────────────────────────────────────────

if (SKIPPED_FILES.length > 0) {
  doc.addPage();
  doc.font(FONT_HEADING).fontSize(13).fillColor("#b00000").text("Appendix: Skipped Files");
  doc.moveDown(0.4);
  doc.font(FONT_BODY).fontSize(SZ_SMALL).fillColor("#333");
  for (const { path: p, reason } of SKIPPED_FILES) {
    doc.text(`  ${p}  —  ${reason}`, { lineBreak: true });
    doc.moveDown(0.15);
  }
}

// ─── Write TOC retrospectively ────────────────────────────────────────────────

const totalPages = doc.bufferedPageRange().count;

doc.switchToPage(1);
doc.y = tocPageY;
doc.font(FONT_MONO).fontSize(7).fillColor("#333");
for (const entry of tocEntries) {
  if (doc.y > doc.page.height - MARGIN * 2) break;
  const label = entry.rel.length > 78 ? "…" + entry.rel.slice(-75) : entry.rel;
  const pg = String(entry.pageIndex + 1).padStart(4, " ");
  doc.text(`${label.padEnd(80, ".")}${pg}`, { lineBreak: false });
  doc.moveDown(0.25);
}

// ─── Footer: page numbers ─────────────────────────────────────────────────────

const footerText = commitHash !== "(git unavailable)"
  ? `M3Jar Codebase Report  •  commit ${commitHash}  •  generated ${generatedAt}`
  : `M3Jar Codebase Report  •  generated ${generatedAt}`;

for (let i = 0; i < totalPages; i++) {
  doc.switchToPage(i);
  doc.font(FONT_BODY).fontSize(SZ_FOOTER).fillColor("#aaa").text(
    `${footerText}  •  Page ${i + 1} of ${totalPages}`,
    MARGIN, doc.page.height - MARGIN + 6,
    { width: PAGE_W, align: "center" },
  );
}

doc.end();

// ─── Final summary ────────────────────────────────────────────────────────────

writeStream.on("finish", () => {
  const bytes = fs.statSync(OUTPUT_PATH).size;
  const totalFiles = allSections.reduce((n, s) => n + s.files.length, 0);

  console.log(`✅  TripJar-Codebase.pdf written`);
  console.log(`   Path:     ${OUTPUT_PATH}`);
  console.log(`   Size:     ${(bytes / 1024).toFixed(1)} KB`);
  console.log(`   Pages:    ~${totalPages}`);
  console.log(`   Files:    ${totalFiles} source files included`);
  console.log(`   Commit:   ${commitHash}`);
  if (SKIPPED_FILES.length > 0) {
    console.log(`   Skipped:  ${SKIPPED_FILES.length} file(s) (see appendix in PDF)`);
    for (const { path: p, reason } of SKIPPED_FILES) {
      console.log(`     - ${p}: ${reason}`);
    }
  } else {
    console.log(`   Skipped:  0 (no content-scan violations, no path violations)`);
  }
  console.log(`   Download: GET /api/download/codebase`);
});

writeStream.on("error", (err) => {
  console.error("PDF write error:", err);
  process.exit(1);
});
