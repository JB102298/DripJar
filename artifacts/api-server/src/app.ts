import express, { type Express } from "express";
import cors from "cors";
import helmet from "helmet";
import pinoHttp from "pino-http";
import router from "./routes/index.js";
import { logger } from "./lib/logger.js";

const app: Express = express();

// Trust proxy for deployed environments
app.set("trust proxy", 1);

// ─── Security headers ─────────────────────────────────────────────────────────

// CSP: enabled in production only. This service is an API-only origin (all
// routes serve JSON under /api; the Expo web app is served by a separate
// static server), so a restrictive policy is safe and cannot break the web
// app's own resources. Development keeps CSP disabled so Replit previews and
// Expo dev tooling continue to work unchanged.
export function buildHelmetOptions(isProduction: boolean): Parameters<typeof helmet>[0] {
  return {
    // Allow Expo/React Native web previews to load resources
    crossOriginEmbedderPolicy: false,
    contentSecurityPolicy: isProduction
      ? {
          directives: {
            defaultSrc: ["'none'"],
            frameAncestors: ["'none'"],
            baseUri: ["'none'"],
            formAction: ["'none'"],
          },
        }
      : false,
  };
}

app.use(helmet(buildHelmetOptions(process.env["NODE_ENV"] === "production")));
app.disable("x-powered-by");

// ─── Request logging ──────────────────────────────────────────────────────────

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
          // Never log Authorization header or any token
        };
      },
      res(res) {
        return { statusCode: res.statusCode };
      },
    },
  }),
);

// ─── CORS — exact origin matching ────────────────────────────────────────────

/**
 * Parse ALLOWED_ORIGINS env var into a Set of normalized origin strings.
 * Uses `new URL()` origin semantics — no substring matching.
 *
 * Returns null when the variable is absent (allow all, dev only).
 * Throws at startup when an entry is malformed.
 */
function buildAllowedOriginSet(): Set<string> | null {
  const raw = process.env["ALLOWED_ORIGINS"];
  if (!raw) return null;

  const origins = new Set<string>();
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    try {
      const normalized = new URL(trimmed).origin;
      if (!normalized || normalized === "null") {
        throw new Error(`Could not normalize origin from "${trimmed}"`);
      }
      origins.add(normalized);
    } catch (err) {
      throw new Error(
        `ALLOWED_ORIGINS entry "${trimmed}" is invalid: ${(err as Error).message}`,
      );
    }
  }
  return origins.size > 0 ? origins : null;
}

const allowedOriginSet = buildAllowedOriginSet();

app.use(
  cors({
    origin: allowedOriginSet
      ? (incomingOrigin, callback) => {
          // No Origin header → allow (native mobile + server-to-server)
          if (!incomingOrigin) {
            callback(null, true);
            return;
          }
          // Exact match only — never use includes/startsWith/regex partial matching
          if (allowedOriginSet.has(incomingOrigin)) {
            callback(null, true);
          } else {
            callback(new Error("Not allowed by CORS"));
          }
        }
      : true, // Dev: allow all origins
    credentials: true,
    methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
);

// ─── Body parsing ─────────────────────────────────────────────────────────────

app.use(express.json({ limit: "256kb" }));
app.use(express.urlencoded({ extended: true, limit: "256kb" }));

// ─── Routes ───────────────────────────────────────────────────────────────────

app.use("/api", router);

// ─── Global error handler ────────────────────────────────────────────────────

app.use(
  (
    err: Error,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    logger.error({ err: { message: err.message, name: err.name } }, "Unhandled error");

    // Never expose stack traces, SQL details, or internal messages in production
    res.status(500).json({
      error: "InternalError",
      message:
        process.env["NODE_ENV"] === "production"
          ? "An internal error occurred"
          : err.message,
    });
  },
);

export default app;
