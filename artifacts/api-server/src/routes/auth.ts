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

async function issueTokenPair(
  userId: string,
  email: string,
  req: { headers: { "user-agent"?: string }; ip?: string },
) {
  const accessToken = signAccessToken(userId, email);
  const { raw: refreshTokenRaw, hash: refreshTokenHash } = createRefreshToken();

  await db.insert(refreshSessions).values({
    userId,
    tokenHash: refreshTokenHash,
    userAgent: (req.headers as Record<string, string>)["user-agent"] ?? null,
    ipAddress: (req as { ip?: string }).ip ?? null,
    expiresAt: refreshTokenExpiresAt(),
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

router.post(
  "/auth/refresh",
  refreshTokenLimiter,
  validate(refreshTokenSchema),
  async (req, res) => {
    const { refreshToken: rawToken } = req.body as { refreshToken: string };
    const tokenHash = hashToken(rawToken);

    const [session] = await db
      .select()
      .from(refreshSessions)
      .where(eq(refreshSessions.tokenHash, tokenHash))
      .limit(1);

    // Token not found at all
    if (!session) {
      res.status(401).json({ error: "Unauthorized", message: "Invalid refresh token" });
      return;
    }

    // Token was already revoked — possible theft/reuse attack; revoke entire family
    if (session.revokedAt !== null) {
      logger.warn({ userId: session.userId }, "Refresh token reuse detected — revoking all sessions");
      await db
        .update(refreshSessions)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(refreshSessions.userId, session.userId),
            isNull(refreshSessions.revokedAt),
          ),
        );
      res.status(401).json({
        error: "Unauthorized",
        message: "Refresh token has already been used. All sessions have been revoked for security.",
      });
      return;
    }

    // Token expired
    if (session.expiresAt < new Date()) {
      await db
        .update(refreshSessions)
        .set({ revokedAt: new Date() })
        .where(eq(refreshSessions.id, session.id));
      res.status(401).json({ error: "Unauthorized", message: "Refresh token has expired" });
      return;
    }

    const [user] = await db.select().from(users).where(eq(users.id, session.userId)).limit(1);
    if (!user) {
      res.status(401).json({ error: "Unauthorized", message: "User not found" });
      return;
    }

    // Rotate: revoke old token and issue new pair atomically
    const { raw: newRefreshRaw, hash: newRefreshHash } = createRefreshToken();
    const newAccessToken = signAccessToken(user.id, user.email);

    await db.transaction(async (tx) => {
      await tx
        .update(refreshSessions)
        .set({ revokedAt: new Date() })
        .where(eq(refreshSessions.id, session.id));

      await tx.insert(refreshSessions).values({
        userId: user.id,
        tokenHash: newRefreshHash,
        userAgent: session.userAgent,
        ipAddress: session.ipAddress,
        expiresAt: refreshTokenExpiresAt(),
      });
    });

    res.json({ token: newAccessToken, refreshToken: newRefreshRaw });
  },
);

// ─── POST /auth/logout ────────────────────────────────────────────────────────

router.post("/auth/logout", requireAuth, validate(refreshTokenSchema), async (req, res) => {
  const { refreshToken: rawToken } = req.body as { refreshToken: string };
  const tokenHash = hashToken(rawToken);

  await db
    .update(refreshSessions)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(refreshSessions.tokenHash, tokenHash),
        isNull(refreshSessions.revokedAt),
      ),
    );

  res.json({ message: "Logged out successfully" });
});

// ─── POST /auth/logout-all ────────────────────────────────────────────────────

router.post("/auth/logout-all", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).userId;

  await db
    .update(refreshSessions)
    .set({ revokedAt: new Date() })
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
        .set({ revokedAt: new Date() })
        .where(
          and(eq(refreshSessions.userId, user.id), isNull(refreshSessions.revokedAt)),
        );
    });

    res.json({ message: "Password reset successfully. Please log in with your new password." });
  },
);

export default router;
