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

// ─── Production-only environment requirements (DJ-012) ───────────────────────
//
// Email delivery fails *open* by design: when RESEND_API_KEY is absent the send
// helpers log a warning and return false so dev and test can run without a
// provider. In production that same behaviour is a silent outage — the server
// reports healthy while no user can complete password reset or email
// verification, because tokens are issued and stored but the mail never leaves.
//
// APP_BASE_URL is required alongside it: every emailed link is built from it,
// so a missing value would produce links to a fallback host that may not be the
// deployment's real origin.
//
// Values are never logged — only whether each is present.
if (process.env["NODE_ENV"] === "production") {
  const requiredInProduction = ["RESEND_API_KEY", "APP_BASE_URL"] as const;
  const missing = requiredInProduction.filter((name) => !process.env[name]);

  if (missing.length > 0) {
    console.error(
      `[FATAL] Missing required production environment variable(s): ${missing.join(", ")}. ` +
      "Email delivery and emailed links cannot function without them. " +
      "Set them, or run with NODE_ENV != production for local development.",
    );
    process.exit(1);
  }
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
