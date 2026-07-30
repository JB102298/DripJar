import { Router } from "express";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import { db } from "@workspace/db";
import { users, profiles, refreshSessions } from "@workspace/db";
import { eq, and, isNull } from "drizzle-orm";
import {
  requireAuth,
  signAccessToken,
  createRefreshToken,
  hashToken,
  refreshTokenExpiresAt,
  type AuthenticatedRequest,
} from "../lib/auth.js";
import {
  validate,
  registerSchema,
  loginSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  refreshTokenSchema,
} from "../lib/validation.js";
import {
  loginLimiter,
  registerLimiter,
  forgotPasswordLimiter,
  resetPasswordLimiter,
  refreshTokenLimiter,
} from "../lib/rate-limit.js";
import { logger } from "../lib/logger.js";

const router = Router();

// ─── Helper: build safe user/profile shape ────────────────────────────────────

function safeUser(u: typeof users.$inferSelect) {
  return {
    id: u.id,
    email: u.email,
    emailVerified: u.emailVerified,
    createdAt: u.createdAt,
  };
}

function safeProfile(p: typeof profiles.$inferSelect) {
  return {
    id: p.id,
    userId: p.userId,
    firstName: p.firstName,
    lastName: p.lastName,
    displayName: p.displayName,
    avatarUrl: p.avatarUrl,
    phone: p.phone,
    timeZone: p.timeZone,
    defaultCurrency: p.defaultCurrency,
    createdAt: p.createdAt,
  };
}

// ─── Helper: issue a token pair and create a refresh session ──────────────────
//
// Each call starts a new token *family*.  On rotation the family is inherited
// from the parent session so the entire chain stays linked.

async function issueTokenPair(
  userId: string,
  email: string,
  req: { headers: { "user-agent"?: string }; ip?: string },
) {
  const accessToken = signAccessToken(userId, email);
  const { raw: refreshTokenRaw, hash: refreshTokenHash } = createRefreshToken();
  const familyId = crypto.randomUUID(); // new family per login / register

  await db.insert(refreshSessions).values({
    userId,
    tokenHash: refreshTokenHash,
    userAgent: (req.headers as Record<string, string>)["user-agent"] ?? null,
    ipAddress: (req as { ip?: string }).ip ?? null,
    expiresAt: refreshTokenExpiresAt(),
    familyId,
  });

  return { accessToken, refreshTokenRaw };
}

// ─── POST /auth/register ──────────────────────────────────────────────────────

router.post(
  "/auth/register",
  registerLimiter,
  validate(registerSchema),
  async (req, res) => {
    const { email, password, firstName, lastName } = req.body as {
      email: string;
      password: string;
      firstName: string;
      lastName: string;
    };

    const existing = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    if (existing.length > 0) {
      res
        .status(409)
        .json({ error: "Conflict", message: "An account with this email already exists" });
      return;
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const displayName = `${firstName} ${lastName}`.trim();

    // Transaction: create user + profile atomically
    const result = await db.transaction(async (tx) => {
      const [newUser] = await tx
        .insert(users)
        .values({ email, passwordHash, emailVerified: false, lastLoginAt: new Date() })
        .returning();

      if (!newUser) throw new Error("Failed to create user");

      const [newProfile] = await tx
        .insert(profiles)
        .values({
          userId: newUser.id,
          firstName,
          lastName,
          displayName,
          timeZone: "America/New_York",
          defaultCurrency: "USD",
        })
        .returning();

      if (!newProfile) throw new Error("Failed to create profile");

      return { newUser, newProfile };
    });

    const { accessToken, refreshTokenRaw } = await issueTokenPair(
      result.newUser.id,
      result.newUser.email,
      req,
    );

    res.status(201).json({
      token: accessToken,
      refreshToken: refreshTokenRaw,
      user: safeUser(result.newUser),
      profile: safeProfile(result.newProfile),
    });
  },
);

// ─── POST /auth/login ─────────────────────────────────────────────────────────

router.post("/auth/login", loginLimiter, validate(loginSchema), async (req, res) => {
  const { email, password } = req.body as { email: string; password: string };

  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  if (!user || !user.passwordHash) {
    res.status(401).json({ error: "Unauthorized", message: "Invalid email or password" });
    return;
  }

  const passwordValid = await bcrypt.compare(password, user.passwordHash);
  if (!passwordValid) {
    res.status(401).json({ error: "Unauthorized", message: "Invalid email or password" });
    return;
  }

  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));

  const [profile] = await db
    .select()
    .from(profiles)
    .where(eq(profiles.userId, user.id))
    .limit(1);

  const { accessToken, refreshTokenRaw } = await issueTokenPair(user.id, user.email, req);

  res.json({
    token: accessToken,
    refreshToken: refreshTokenRaw,
    user: safeUser(user),
    profile: profile ? safeProfile(profile) : null,
  });
});

// ─── POST /auth/refresh ───────────────────────────────────────────────────────
//
// Atomic rotation with row-level locking:
//
//  1. Open a transaction.
//  2. SELECT … FOR UPDATE — acquires an exclusive row lock so concurrent
//     requests using the same token are serialised rather than racing.
//  3. Validate the session (not found / already revoked / expired).
//  4. If the token is found but already revoked (revokedAt ≠ null) this is a
//     replay attempt.  Revoke every active session in the same token family and
//     return a generic 401 — do not reveal that replay was detected.
//  5. On success: mark old session revoked ('rotated'), insert new session
//     inheriting the same familyId, commit, return new token pair.
//
// Network-loss behaviour: if the server rotates the token but the response
// never reaches the client, the client retries with the old token.  That token
// is now 'rotated' and the server treats it as a replay, revoking the family.
// The client must re-authenticate.  This is intentionally strict — weakening
// it to allow a retry window would erode the replay guarantee.  The mobile
// client's mutex (refreshLockRef) already prevents spurious concurrent calls
// from the same device in normal operation.

router.post(
  "/auth/refresh",
  refreshTokenLimiter,
  validate(refreshTokenSchema),
  async (req, res) => {
    const { refreshToken: rawToken } = req.body as { refreshToken: string };
    const tokenHash = hashToken(rawToken);

    type RotateResult =
      | { ok: true; accessToken: string; refreshTokenRaw: string }
      | { ok: false };

    const result = await db.transaction(async (tx): Promise<RotateResult> => {

      // ── 1. Locate and lock the session row ──────────────────────────────────
      const [session] = await tx
        .select()
        .from(refreshSessions)
        .where(eq(refreshSessions.tokenHash, tokenHash))
        .for("update")
        .limit(1);

      if (!session) {
        return { ok: false };
      }

      // ── 2. Replay detection ─────────────────────────────────────────────────
      // Token was already revoked (rotated, logged out, expired, etc.).
      // Revoke every remaining active session in this token family and return
      // a generic error — never reveal that replay was detected.
      if (session.revokedAt !== null) {
        logger.warn(
          { userId: session.userId, familyId: session.familyId },
          "Refresh token replay detected — revoking token family",
        );
        await tx
          .update(refreshSessions)
          .set({ revokedAt: new Date(), revokeReason: "token_reuse_detected" })
          .where(
            and(
              eq(refreshSessions.familyId, session.familyId),
              isNull(refreshSessions.revokedAt),
            ),
          );
        return { ok: false };
      }

      // ── 3. Expiry check ─────────────────────────────────────────────────────
      if (session.expiresAt < new Date()) {
        await tx
          .update(refreshSessions)
          .set({ revokedAt: new Date(), revokeReason: "expired" })
          .where(eq(refreshSessions.id, session.id));
        return { ok: false };
      }

      // ── 4. Load user (inside transaction for read consistency) ──────────────
      const [user] = await tx
        .select({ id: users.id, email: users.email })
        .from(users)
        .where(eq(users.id, session.userId))
        .limit(1);

      if (!user) {
        return { ok: false };
      }

      // ── 5. Rotate: revoke old session, issue new one in the same family ─────
      const { raw: newRaw, hash: newHash } = createRefreshToken();
      const newAccessToken = signAccessToken(user.id, user.email);

      await tx
        .update(refreshSessions)
        .set({ revokedAt: new Date(), revokeReason: "rotated" })
        .where(eq(refreshSessions.id, session.id));

      await tx.insert(refreshSessions).values({
        userId: user.id,
        tokenHash: newHash,
        userAgent: session.userAgent,
        ipAddress: session.ipAddress,
        expiresAt: refreshTokenExpiresAt(),
        familyId: session.familyId, // inherit family → chain stays linked
      });

      return { ok: true, accessToken: newAccessToken, refreshTokenRaw: newRaw };
    });

    if (!result.ok) {
      res.status(401).json({ error: "Unauthorized", message: "Invalid refresh token" });
      return;
    }

    res.json({ token: result.accessToken, refreshToken: result.refreshTokenRaw });
  },
);

// ─── POST /auth/logout ────────────────────────────────────────────────────────
//
// Revokes every active session in the same token family as the submitted
// refresh token — not just the single row matching the hash.  This ensures
// no sibling or descendant token in the same rotation chain can be reused
// after the user logs out (e.g. if a rotated-but-undelivered token exists).

router.post("/auth/logout", requireAuth, validate(refreshTokenSchema), async (req, res) => {
  const { refreshToken: rawToken } = req.body as { refreshToken: string };
  const tokenHash = hashToken(rawToken);

  // Find the session's familyId (active sessions only — already-revoked tokens
  // are silently ignored so logout is always a clean no-error response).
  const [session] = await db
    .select({ familyId: refreshSessions.familyId })
    .from(refreshSessions)
    .where(and(eq(refreshSessions.tokenHash, tokenHash), isNull(refreshSessions.revokedAt)))
    .limit(1);

  if (session) {
    // Revoke the entire family so no chain member can be replayed after logout
    await db
      .update(refreshSessions)
      .set({ revokedAt: new Date(), revokeReason: "logout" })
      .where(
        and(
          eq(refreshSessions.familyId, session.familyId),
          isNull(refreshSessions.revokedAt),
        ),
      );
  }

  res.json({ message: "Logged out successfully" });
});

// ─── POST /auth/logout-all ────────────────────────────────────────────────────

router.post("/auth/logout-all", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).userId;

  await db
    .update(refreshSessions)
    .set({ revokedAt: new Date(), revokeReason: "logout_all" })
    .where(
      and(eq(refreshSessions.userId, userId), isNull(refreshSessions.revokedAt)),
    );

  res.json({ message: "All sessions revoked successfully" });
});

// ─── GET /auth/me ─────────────────────────────────────────────────────────────

router.get("/auth/me", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).userId;

  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) {
    res.status(401).json({ error: "Unauthorized", message: "User not found" });
    return;
  }

  const [profile] = await db
    .select()
    .from(profiles)
    .where(eq(profiles.userId, userId))
    .limit(1);

  // Return the same access token so the client can track it
  res.json({
    token: req.headers.authorization?.slice(7) ?? "",
    user: safeUser(user),
    profile: profile ? safeProfile(profile) : null,
  });
});

// ─── POST /auth/forgot-password ───────────────────────────────────────────────

router.post(
  "/auth/forgot-password",
  forgotPasswordLimiter,
  validate(forgotPasswordSchema),
  async (req, res) => {
    const { email } = req.body as { email: string };

    const [user] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    if (user) {
      const rawToken = crypto.randomBytes(32).toString("hex");
      const tokenHash = hashToken(rawToken);
      const expiresAt = new Date(Date.now() + 3600 * 1000);

      await db
        .update(users)
        .set({ resetTokenHash: tokenHash, resetTokenExpiresAt: expiresAt })
        .where(eq(users.id, user.id));

      // In production: send email with link containing rawToken
      // rawToken is NEVER logged in production
      if (process.env["DEV_SHOW_RESET_TOKEN"] === "true") {
        logger.info({ hint: "dev-only reset token preview" }, "Password reset requested");
        res.json({
          message: "If an account exists with this email, you will receive reset instructions.",
          _dev_token: rawToken,
        });
        return;
      }
    }

    // Always return 200 — prevents email enumeration
    res.json({
      message: "If an account exists with this email, you will receive reset instructions.",
    });
  },
);

// ─── POST /auth/reset-password ────────────────────────────────────────────────

router.post(
  "/auth/reset-password",
  resetPasswordLimiter,
  validate(resetPasswordSchema),
  async (req, res) => {
    const { token: rawToken, password } = req.body as { token: string; password: string };
    const tokenHash = hashToken(rawToken);

    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.resetTokenHash, tokenHash))
      .limit(1);

    if (!user || !user.resetTokenExpiresAt || user.resetTokenExpiresAt < new Date()) {
      res
        .status(400)
        .json({ error: "BadRequest", message: "Invalid or expired reset token" });
      return;
    }

    const passwordHash = await bcrypt.hash(password, 12);

    // Transaction: update password, clear token, revoke all sessions
    await db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({ passwordHash, resetTokenHash: null, resetTokenExpiresAt: null })
        .where(eq(users.id, user.id));

      await tx
        .update(refreshSessions)
        .set({ revokedAt: new Date(), revokeReason: "password_reset" })
        .where(
          and(eq(refreshSessions.userId, user.id), isNull(refreshSessions.revokedAt)),
        );
    });

    res.json({ message: "Password reset successfully. Please log in with your new password." });
  },
);

export default router;
