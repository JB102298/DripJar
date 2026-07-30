import jwt from "jsonwebtoken";
import crypto from "node:crypto";
import { nanoid } from "nanoid";
import { type Request, type Response, type NextFunction } from "express";

// ─── Startup validation ───────────────────────────────────────────────────────

const rawSecret = process.env["JWT_SECRET"];
if (!rawSecret) {
  console.error(
    "[FATAL] JWT_SECRET environment variable is required but was not provided. " +
    "Set it to a cryptographically random string of at least 32 characters.",
  );
  process.exit(1);
}
if (rawSecret.length < 32) {
  console.error(
    `[FATAL] JWT_SECRET is too short (${rawSecret.length} chars). ` +
    "A minimum of 32 characters is required.",
  );
  process.exit(1);
}

const JWT_SECRET: string = rawSecret;

// ─── Token lifetimes ─────────────────────────────────────────────────────────

const ACCESS_TOKEN_EXPIRY = "15m";
const REFRESH_TOKEN_DAYS = 30;

// ─── Interfaces ──────────────────────────────────────────────────────────────

export interface AuthenticatedRequest extends Request {
  userId: string;
  userEmail: string;
}

// ─── JWT helpers ─────────────────────────────────────────────────────────────

/**
 * Sign a 15-minute access token.
 * Kept as `signToken` for backward compat; callers should prefer `signAccessToken`.
 */
export function signToken(userId: string, email: string): string {
  return jwt.sign({ userId, email, type: "access", jti: nanoid() }, JWT_SECRET, {
    expiresIn: ACCESS_TOKEN_EXPIRY,
  });
}

export const signAccessToken = signToken;

// ─── Refresh token helpers ────────────────────────────────────────────────────

/**
 * Generate a cryptographically random refresh token.
 * Returns the raw token (sent to client) and its SHA-256 hash (stored in DB).
 */
export function createRefreshToken(): { raw: string; hash: string } {
  const raw = crypto.randomBytes(40).toString("hex");
  const hash = hashToken(raw);
  return { raw, hash };
}

/**
 * Compute the SHA-256 hash of a token.
 * Use this to compare a submitted token against a stored hash.
 */
export function hashToken(raw: string): string {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

/**
 * Compute the expiry Date for a new refresh session.
 */
export function refreshTokenExpiresAt(): Date {
  const d = new Date();
  d.setDate(d.getDate() + REFRESH_TOKEN_DAYS);
  return d;
}

// ─── Middleware ───────────────────────────────────────────────────────────────

export function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Unauthorized", message: "Missing or invalid auth token" });
    return;
  }

  const token = authHeader.slice(7);
  try {
    const payload = jwt.verify(token, JWT_SECRET) as {
      userId: string;
      email: string;
    };
    (req as AuthenticatedRequest).userId = payload.userId;
    (req as AuthenticatedRequest).userEmail = payload.email;
    next();
  } catch {
    res.status(401).json({ error: "Unauthorized", message: "Invalid or expired token" });
  }
}
