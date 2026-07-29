import { Router } from "express";
import bcrypt from "bcryptjs";
import { db } from "@workspace/db";
import { users, profiles } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireAuth, signToken, type AuthenticatedRequest } from "../lib/auth.js";
import crypto from "node:crypto";

const router = Router();

// POST /auth/register
router.post("/auth/register", async (req, res) => {
  const { email, password, firstName, lastName } = req.body as {
    email?: string;
    password?: string;
    firstName?: string;
    lastName?: string;
  };

  if (!email || !password || !firstName || !lastName) {
    res.status(400).json({ error: "BadRequest", message: "All fields are required" });
    return;
  }

  if (password.length < 8) {
    res.status(400).json({ error: "BadRequest", message: "Password must be at least 8 characters" });
    return;
  }

  const existing = await db.select().from(users).where(eq(users.email, email.toLowerCase())).limit(1);
  if (existing.length > 0) {
    res.status(409).json({ error: "Conflict", message: "An account with this email already exists" });
    return;
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const displayName = `${firstName} ${lastName}`.trim();

  const [newUser] = await db.insert(users).values({
    email: email.toLowerCase(),
    passwordHash,
    emailVerified: false,
    lastLoginAt: new Date(),
  }).returning();

  if (!newUser) {
    res.status(500).json({ error: "InternalError", message: "Failed to create user" });
    return;
  }

  const [newProfile] = await db.insert(profiles).values({
    userId: newUser.id,
    firstName,
    lastName,
    displayName,
    timeZone: "America/New_York",
    defaultCurrency: "USD",
  }).returning();

  if (!newProfile) {
    res.status(500).json({ error: "InternalError", message: "Failed to create profile" });
    return;
  }

  const token = signToken(newUser.id, newUser.email);

  res.status(201).json({
    token,
    user: {
      id: newUser.id,
      email: newUser.email,
      emailVerified: newUser.emailVerified,
      createdAt: newUser.createdAt,
    },
    profile: {
      id: newProfile.id,
      userId: newProfile.userId,
      firstName: newProfile.firstName,
      lastName: newProfile.lastName,
      displayName: newProfile.displayName,
      avatarUrl: newProfile.avatarUrl,
      phone: newProfile.phone,
      timeZone: newProfile.timeZone,
      defaultCurrency: newProfile.defaultCurrency,
      createdAt: newProfile.createdAt,
    },
  });
});

// POST /auth/login
router.post("/auth/login", async (req, res) => {
  const { email, password } = req.body as { email?: string; password?: string };

  if (!email || !password) {
    res.status(400).json({ error: "BadRequest", message: "Email and password are required" });
    return;
  }

  const [user] = await db.select().from(users).where(eq(users.email, email.toLowerCase())).limit(1);
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

  const [profile] = await db.select().from(profiles).where(eq(profiles.userId, user.id)).limit(1);

  const token = signToken(user.id, user.email);

  res.json({
    token,
    user: {
      id: user.id,
      email: user.email,
      emailVerified: user.emailVerified,
      createdAt: user.createdAt,
    },
    profile: profile
      ? {
          id: profile.id,
          userId: profile.userId,
          firstName: profile.firstName,
          lastName: profile.lastName,
          displayName: profile.displayName,
          avatarUrl: profile.avatarUrl,
          phone: profile.phone,
          timeZone: profile.timeZone,
          defaultCurrency: profile.defaultCurrency,
          createdAt: profile.createdAt,
        }
      : null,
  });
});

// POST /auth/logout
router.post("/auth/logout", (_req, res) => {
  res.json({ message: "Logged out successfully" });
});

// GET /auth/me
router.get("/auth/me", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).userId;

  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) {
    res.status(401).json({ error: "Unauthorized", message: "User not found" });
    return;
  }

  const [profile] = await db.select().from(profiles).where(eq(profiles.userId, userId)).limit(1);

  res.json({
    token: req.headers.authorization?.slice(7) ?? "",
    user: {
      id: user.id,
      email: user.email,
      emailVerified: user.emailVerified,
      createdAt: user.createdAt,
    },
    profile: profile
      ? {
          id: profile.id,
          userId: profile.userId,
          firstName: profile.firstName,
          lastName: profile.lastName,
          displayName: profile.displayName,
          avatarUrl: profile.avatarUrl,
          phone: profile.phone,
          timeZone: profile.timeZone,
          defaultCurrency: profile.defaultCurrency,
          createdAt: profile.createdAt,
        }
      : null,
  });
});

// POST /auth/forgot-password
router.post("/auth/forgot-password", async (req, res) => {
  const { email } = req.body as { email?: string };
  if (!email) {
    res.status(400).json({ error: "BadRequest", message: "Email is required" });
    return;
  }

  const [user] = await db.select().from(users).where(eq(users.email, email.toLowerCase())).limit(1);
  if (user) {
    const resetToken = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 3600 * 1000); // 1 hour
    await db.update(users)
      .set({ resetToken, resetTokenExpiresAt: expiresAt })
      .where(eq(users.id, user.id));
    // In production: send email with reset link
    // For dev: token is in DB, accessible via logs
  }

  // Always return 200 to prevent email enumeration
  res.json({ message: "If an account exists with this email, you will receive reset instructions." });
});

// POST /auth/reset-password
router.post("/auth/reset-password", async (req, res) => {
  const { token, password } = req.body as { token?: string; password?: string };

  if (!token || !password) {
    res.status(400).json({ error: "BadRequest", message: "Token and password are required" });
    return;
  }

  if (password.length < 8) {
    res.status(400).json({ error: "BadRequest", message: "Password must be at least 8 characters" });
    return;
  }

  const [user] = await db.select().from(users).where(eq(users.resetToken, token)).limit(1);
  if (!user || !user.resetTokenExpiresAt || user.resetTokenExpiresAt < new Date()) {
    res.status(400).json({ error: "BadRequest", message: "Invalid or expired reset token" });
    return;
  }

  const passwordHash = await bcrypt.hash(password, 12);
  await db.update(users)
    .set({ passwordHash, resetToken: null, resetTokenExpiresAt: null })
    .where(eq(users.id, user.id));

  res.json({ message: "Password reset successfully. Please log in with your new password." });
});

export default router;
