import rateLimit, { type Options } from "express-rate-limit";

/**
 * Rate limiter factory using an in-memory store.
 *
 * PRODUCTION NOTE: The in-memory store is scoped to a single process.
 * If you run multiple API instances (e.g. horizontal scaling), each instance
 * will have an independent counter and the effective limit will be multiplied
 * by the number of instances.
 *
 * To enforce exact limits across instances, replace the store with a shared
 * adapter such as:
 *   - `rate-limit-redis` (Redis)
 *   - `rate-limit-postgresql` (PostgreSQL)
 *
 * Swap the store here and nowhere else — the rest of the app is unchanged.
 */
function createLimiter(opts: Partial<Options>) {
  // Disable rate limiting in the test environment so the normal test suite can
  // make many requests without tripping in-memory counters.
  // Exception: TEST_RATE_LIMITS=1 opts in to real limiters for the dedicated
  // rate-limit verification suite.
  if (process.env["NODE_ENV"] === "test" && process.env["TEST_RATE_LIMITS"] !== "1") {
    return (_req: import("express").Request, _res: import("express").Response, next: import("express").NextFunction) => next();
  }
  return rateLimit({
    standardHeaders: "draft-7",   // Return Retry-After + RateLimit-* headers
    legacyHeaders: false,
    message: {
      error: "TooManyRequests",
      message: "Too many requests, please try again later.",
    },
    ...opts,
  });
}

// ─── Per-endpoint rate limiters ───────────────────────────────────────────────

/** Login: 10 attempts per 15 min per IP */
export const loginLimiter = createLimiter({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  message: {
    error: "TooManyRequests",
    message: "Too many login attempts. Please wait 15 minutes before trying again.",
  },
});

/** Registration: 5 per hour per IP */
export const registerLimiter = createLimiter({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  message: {
    error: "TooManyRequests",
    message: "Too many registration attempts. Please try again in an hour.",
  },
});

/** Forgot password: 5 per hour per IP */
export const forgotPasswordLimiter = createLimiter({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  message: {
    error: "TooManyRequests",
    message: "Too many password reset requests. Please try again in an hour.",
  },
});

/** Reset password: 10 per hour per IP */
export const resetPasswordLimiter = createLimiter({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  message: {
    error: "TooManyRequests",
    message: "Too many password reset attempts. Please try again in an hour.",
  },
});

/** Refresh token: 30 per 15 min per IP */
export const refreshTokenLimiter = createLimiter({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  message: {
    error: "TooManyRequests",
    message: "Too many token refresh requests. Please try again shortly.",
  },
});

/** Invitation lookup/acceptance: 30 per 15 min per IP */
export const invitationLimiter = createLimiter({
  windowMs: 15 * 60 * 1000,
  limit: 30,
});

/** Contribution/commitment: 60 per 15 min per authenticated user (keyed by IP) */
export const contributionLimiter = createLimiter({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  message: {
    error: "TooManyRequests",
    message: "Too many contribution requests. Please slow down.",
  },
});
