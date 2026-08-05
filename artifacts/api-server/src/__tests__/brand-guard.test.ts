/**
 * Brand guard — prevents reintroduction of legacy product names
 * (M3Jar, TripJar) into active customer-facing source code.
 *
 * WHAT IS SCANNED:
 *   Active source directories: API routes/lib, mobile app/hooks/contexts,
 *   API spec, and scripts/src.
 *
 * WHAT IS NOT SCANNED (whitelisted):
 *   - lib/db/drizzle/*.sql     — historical migration files; immutable by design
 *   - contexts/auth-context.tsx — internal AsyncStorage key names (not
 *     customer-visible; changing them would log out existing users)
 *   - __tests__/auth-context.test.tsx — references those same internal keys
 *   - run-fresh-migration.*    — internal dev DB names (not customer-visible)
 *   - verify-fresh-migration.sh — internal dev DB names
 *   - brand-guard.test.ts      — this file (contains the pattern strings)
 *   - *.pdf                    — binary artifacts
 *   - attached_assets/         — user-uploaded spec/reference files
 *   - .agents/                 — agent memory files
 *   - scripts/gen-*.cjs        — archived phase closure reports (historical)
 *
 * A failure here means a legacy brand string was found in active code.
 * Fix it rather than widening the whitelist.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative, extname } from "path";

const WORKSPACE_ROOT = join(__dirname, "../../../..");

// Pattern strings stored as arrays to avoid matching this file itself.
// Each entry is tested case-sensitively or case-insensitively as appropriate.
const LEGACY_EXACT: string[] = ["M3Jar", "TripJar"];
const LEGACY_CI: string[] = ["m3jar.com", "@m3jar.dev", "updates.m3jar.com"];

const SCAN_DIRS = [
  "artifacts/api-server/src",
  "artifacts/mobile/app",
  "artifacts/mobile/hooks",
  "artifacts/mobile/contexts",
  "artifacts/mobile/components",
  "lib/api-spec",
  "scripts/src",
];

const TEXT_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".yaml", ".yml", ".json", ".md"]);

const WHITELIST: RegExp[] = [
  /brand-guard\.test\.[tj]s$/,
  /\/drizzle\//,
  /contexts\/auth-context\.tsx$/,
  /__tests__\/auth-context\.test\.tsx$/,
  /run-fresh-migration\.(cjs|mjs)$/,
  /verify-fresh-migration\.sh$/,
  /scripts\/gen-.*\.cjs$/,
  /scripts\/generate-.*\.cjs$/,
];

function isWhitelisted(relPath: string): boolean {
  return WHITELIST.some((p) => p.test(relPath));
}

function collectFiles(dir: string): string[] {
  const abs = join(WORKSPACE_ROOT, dir);
  const results: string[] = [];
  function walk(d: string) {
    let entries: string[];
    try { entries = readdirSync(d); } catch { return; }
    for (const entry of entries) {
      if (entry === "node_modules" || entry === "dist" || entry === ".git") continue;
      const full = join(d, entry);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) {
        walk(full);
      } else if (TEXT_EXTENSIONS.has(extname(full))) {
        results.push(full);
      }
    }
  }
  walk(abs);
  return results;
}

const allFiles = SCAN_DIRS.flatMap(collectFiles);
const filesToCheck = allFiles.filter((f) => {
  const rel = relative(WORKSPACE_ROOT, f);
  return !isWhitelisted(rel);
});

describe("Brand guard — legacy brand names absent from active source", () => {
  it("covers at least 10 active source files", () => {
    expect(filesToCheck.length).toBeGreaterThan(10);
  });

  for (const filePath of filesToCheck) {
    const relPath = relative(WORKSPACE_ROOT, filePath);

    it(`${relPath} — no legacy exact-case brand names`, () => {
      const content = readFileSync(filePath, "utf-8");
      for (const term of LEGACY_EXACT) {
        expect(
          content.includes(term),
          `Found legacy brand "${term}" in ${relPath}`,
        ).toBe(false);
      }
    });

    it(`${relPath} — no legacy domain/email brand names`, () => {
      const content = readFileSync(filePath, "utf-8").toLowerCase();
      for (const term of LEGACY_CI) {
        expect(
          content.includes(term.toLowerCase()),
          `Found legacy domain "${term}" in ${relPath}`,
        ).toBe(false);
      }
    });
  }
});
