/**
 * CLI wrapper for the local-only owner-QA reset.
 *
 * All of the behaviour — guards, manifest, delete order, reconciliation — lives
 * in `artifacts/api-server/src/lib/owner-reset.ts`, where it is typechecked and
 * covered by `src/__tests__/owner-reset.test.ts`. `scripts/` has no test runner
 * and is not part of the typecheck sweep, so keeping the logic here would leave
 * a destructive tool unverified.
 *
 * This file is only argument parsing and process exit.
 *
 * Usage:
 *   # dry run — prints the manifest, writes nothing
 *   pnpm --filter @workspace/scripts run reset-owner -- --email jordan@dripjar.dev
 *
 *   # execute
 *   pnpm --filter @workspace/scripts run reset-owner -- --email jordan@dripjar.dev --confirm
 *
 * Never invoked on app startup or on sign-in. A human types it, with --confirm.
 */

import { pool } from "@workspace/db";
import { runReset } from "../../artifacts/api-server/src/lib/owner-reset.js";

function parseArgs(argv: string[]): { email: string; confirm: boolean } {
  let email = "";
  let confirm = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--email") email = argv[++i] ?? "";
    else if (arg?.startsWith("--email=")) email = arg.slice("--email=".length);
    else if (arg === "--confirm") confirm = true;
  }
  return { email, confirm };
}

const { email, confirm } = parseArgs(process.argv.slice(2));

runReset({ email, confirm })
  .then(() => pool.end())
  .then(() => process.exit(0))
  .catch((err: Error) => {
    console.error(`\n${err.message}\n`);
    void pool.end().finally(() => process.exit(1));
  });
