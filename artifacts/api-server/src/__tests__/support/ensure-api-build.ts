/**
 * Shared helper for tests that exercise startup validation.
 *
 * `src/index.ts` performs its environment checks as a real process before
 * importing the app, so those code paths cannot be reached by importing
 * `app.ts` — the tests must spawn the built bundle instead.
 *
 * `dist/` is gitignored and is removed by a workspace-wide build, so tests that
 * depend on it would otherwise pass or fail based on whatever ran beforehand.
 * Building on demand makes them deterministic on a clean checkout.
 *
 * This file lives outside the `*.test.ts` glob so vitest does not collect it.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("../../../", import.meta.url));

/**
 * Absolute path to the built server entrypoint.
 *
 * Note: `new URL(...).pathname` is NOT usable here — on Windows it yields
 * "/C:/Users/..." which Node resolves relative to cwd as "C:\C:\Users\...".
 */
export const DIST_INDEX_PATH = fileURLToPath(
  new URL("../../../dist/index.mjs", import.meta.url),
);

/** Build the api-server bundle if it is not already present. Idempotent. */
export function ensureApiBuild(): void {
  if (existsSync(DIST_INDEX_PATH)) return;

  const build = spawnSync("node", ["./build.mjs"], {
    cwd: packageRoot,
    encoding: "utf8",
    timeout: 120_000,
  });

  if (build.status !== 0 || !existsSync(DIST_INDEX_PATH)) {
    throw new Error(
      `Failed to build api-server for startup-validation tests.\n` +
      `stdout: ${build.stdout ?? ""}\nstderr: ${build.stderr ?? ""}`,
    );
  }
}
