// ─── Startup environment validation ──────────────────────────────────────────
// Must run before importing app so JWT_SECRET check fires before any modules load.

const jwtSecret = process.env["JWT_SECRET"];
if (!jwtSecret) {
  console.error(
    "[FATAL] JWT_SECRET environment variable is required but was not set. " +
    "Set it to a cryptographically random string of at least 32 characters.",
  );
  process.exit(1);
}
if (jwtSecret.length < 32) {
  console.error(
    `[FATAL] JWT_SECRET is too short (${jwtSecret.length} chars). Minimum is 32 characters.`,
  );
  process.exit(1);
}

const rawPort = process.env["PORT"];
if (!rawPort) {
  console.error("[FATAL] PORT environment variable is required but was not provided.");
  process.exit(1);
}
const port = Number(rawPort);
if (Number.isNaN(port) || port <= 0) {
  console.error(`[FATAL] Invalid PORT value: "${rawPort}"`);
  process.exit(1);
}

// ─── App startup ──────────────────────────────────────────────────────────────

import app from "./app.js";
import { logger } from "./lib/logger.js";

app.listen(port, (err?: Error) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }
  logger.info({ port }, "Server listening");
});
