/**
 * API path convention guard
 *
 * Every DripJar API route is mounted under `/api` (`app.use("/api", router)` in
 * artifacts/api-server/src/app.ts). `customFetch` prepends only the configured
 * base URL — it does NOT add `/api` — so a call site that passes
 * `/jars/:id/goals` resolves to `http://host/jars/:id/goals` and 404s.
 *
 * The orval-generated client always emits `/api/...`, but hand-written call
 * sites had drifted: 18 of them omitted the prefix, silently breaking Goals,
 * Financial Summary, AutoDrip, and Saved Payment Methods. Those are not
 * type errors and no unit test covered the URL, so nothing caught them.
 *
 * This test closes that hole for the whole repository rather than for the
 * specific call sites that happened to be broken. It parses every source file
 * and asserts that each statically-analysable `customFetch` literal targets
 * `/api/...`. Adding a new hand-written call with a missing prefix fails here.
 *
 * Deliberately a source scan, not a runtime assertion: the point is to cover
 * call sites no test renders, including native-only screens that cannot run
 * under jsdom.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// vitest runs with the package root as cwd. `import.meta.url` is not a file://
// URL under the jsdom environment, so it cannot be used to locate sources here.
const MOBILE_ROOT = process.cwd();

const SKIP_DIRS = new Set(["node_modules", ".expo", "dist", "static-build", "__tests__"]);
const SOURCE_EXT = /\.(ts|tsx)$/;

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) collectSourceFiles(full, out);
    else if (SOURCE_EXT.test(entry)) out.push(full);
  }
  return out;
}

interface CallSite {
  file: string;
  line: number;
  url: string;
}

/**
 * Extract the first argument of each `customFetch(...)` call when it is a
 * string or template literal.
 *
 * Scans forward from the identifier to the opening paren so an inline generic
 * (`customFetch<{ a: string }>(`) — which may span lines and contain braces —
 * is skipped without needing to parse type syntax. Calls whose first argument
 * is a variable are not statically analysable and are ignored rather than
 * guessed at.
 */
function findCustomFetchCalls(source: string, file: string): CallSite[] {
  const calls: CallSite[] = [];
  const ident = /\bcustomFetch\s*(?:<[\s\S]*?>)?\s*\(\s*(['"`])/g;

  let match: RegExpExecArray | null;
  while ((match = ident.exec(source)) !== null) {
    const quote = match[1];
    const start = match.index + match[0].length;
    const end = source.indexOf(quote, start);
    if (end === -1) continue;

    calls.push({
      file,
      line: source.slice(0, match.index).split("\n").length,
      url: source.slice(start, end),
    });
    ident.lastIndex = end;
  }

  return calls;
}

describe("customFetch call sites follow the /api convention", () => {
  const files = collectSourceFiles(MOBILE_ROOT);

  const callSites = files.flatMap((file) =>
    findCustomFetchCalls(readFileSync(file, "utf8"), relative(MOBILE_ROOT, file)),
  );

  it("finds call sites to check (guards against the scan silently matching nothing)", () => {
    expect(callSites.length).toBeGreaterThan(15);
  });

  it("every relative customFetch path starts with /api/", () => {
    // Absolute URLs carry their own origin and path, so the base-URL/prefix
    // logic does not apply to them.
    const relativeCalls = callSites.filter((c) => !/^https?:\/\//.test(c.url));

    const offenders = relativeCalls.filter((c) => !c.url.startsWith("/api/"));

    expect(
      offenders.map((c) => `${c.file}:${c.line} → ${c.url}`),
      "customFetch does not prepend /api; these resolve to a 404",
    ).toEqual([]);
  });

  it("no call site double-prefixes /api/api/", () => {
    const doubled = callSites.filter((c) => c.url.includes("/api/api/"));
    expect(doubled.map((c) => `${c.file}:${c.line} → ${c.url}`)).toEqual([]);
  });
});
