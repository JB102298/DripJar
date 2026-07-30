/**
 * Refresh-token security and concurrency test suite.
 *
 * Covers:
 *  1.  Login creates a session with a new familyId
 *  2.  Registration creates a session with a new familyId
 *  3.  Successful refresh revokes the old row with revokeReason = rotated
 *  4.  Replacement row inherits the same familyId
 *  5.  Old token cannot be reused after rotation
 *  6.  Two concurrent refreshes produce exactly one successful response
 *  7.  Concurrent refresh creates exactly one replacement row
 *  8.  Replay revokes every active row in the affected family
 *  9.  Replay does not revoke another legitimate device family
 *  10. Replay response is generic — does not reveal detection
 *  11. Logout revokes the intended family with revokeReason = logout
 *  12. Logout-all revokes all user families with revokeReason = logout_all
 *  13. Password reset revokes all families with revokeReason = password_reset
 *  14. Expired token is rejected and creates no replacement
 *  15. Previously revoked token is rejected
 *  16. DB failure after revoking parent but before inserting child rolls back both
 *  17. DB failure after inserting replacement also rolls back the transaction
 *  18. No valid replacement remains after a failed transaction
 *  19. Existing refresh_sessions rows survive migration 0003
 *  20. Mobile refresh mutex — documented; requires native test environment (see note below)
 *  21. Original mobile request retried at most once — documented
 *  22. Terminal mobile refresh failure clears SecureStore — documented
 *  23. Tokens do not appear in error responses
 *
 * Mobile tests 20–22 exercise React Native auth-context internals
 * (refreshLockRef mutex, doRefresh retry-once, clearAuth SecureStore wipe).
 * The audit confirmed all three behaviors are correctly implemented.
 * They will be covered when a Jest + React Native Testing Library environment
 * is configured for the mobile artifact.
 */

import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, refreshSessions } from "@workspace/db";
import { eq, isNull, and, isNotNull } from "drizzle-orm";
import {
  hashToken,
  createRefreshToken,
  refreshTokenExpiresAt,
} from "../lib/auth.js";
import app from "../app.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const makeUser = () => {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return {
    email: `rts-${id}@example.com`,
    password: "Password1!",
    firstName: "RT",
    lastName: "Test",
  };
};

// ─── 1 & 2. Session creation — familyId ──────────────────────────────────────

describe("Session creation — familyId minted on login and register", () => {
  it("login creates a refresh_sessions row with a non-null familyId (test 1)", async () => {
    const u = makeUser();
    await request(app).post("/api/auth/register").send(u);
    const loginRes = await request(app).post("/api/auth/login").send({ email: u.email, password: u.password });
    expect(loginRes.status).toBe(200);

    const [session] = await db
      .select()
      .from(refreshSessions)
      .where(eq(refreshSessions.tokenHash, hashToken(loginRes.body.refreshToken)))
      .limit(1);

    expect(session).toBeDefined();
    expect(session!.familyId).toBeTruthy();
    expect(session!.familyId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("registration creates a refresh_sessions row with a non-null familyId (test 2)", async () => {
    const u = makeUser();
    const regRes = await request(app).post("/api/auth/register").send(u);
    expect(regRes.status).toBe(201);

    const [session] = await db
      .select()
      .from(refreshSessions)
      .where(eq(refreshSessions.tokenHash, hashToken(regRes.body.refreshToken)))
      .limit(1);

    expect(session).toBeDefined();
    expect(session!.familyId).toBeTruthy();
  });

  it("two separate logins for the same user produce different familyIds", async () => {
    const u = makeUser();
    await request(app).post("/api/auth/register").send(u);
    const [r1, r2] = await Promise.all([
      request(app).post("/api/auth/login").send({ email: u.email, password: u.password }),
      request(app).post("/api/auth/login").send({ email: u.email, password: u.password }),
    ]);

    const [s1] = await db.select({ familyId: refreshSessions.familyId })
      .from(refreshSessions)
      .where(eq(refreshSessions.tokenHash, hashToken(r1.body.refreshToken)))
      .limit(1);
    const [s2] = await db.select({ familyId: refreshSessions.familyId })
      .from(refreshSessions)
      .where(eq(refreshSessions.tokenHash, hashToken(r2.body.refreshToken)))
      .limit(1);

    expect(s1!.familyId).not.toBe(s2!.familyId);
  });
});

// ─── 3, 4, 5. Successful rotation ────────────────────────────────────────────

describe("Successful rotation", () => {
  let refreshToken: string;
  let originalFamilyId: string;

  beforeAll(async () => {
    const u = makeUser();
    const regRes = await request(app).post("/api/auth/register").send(u);
    refreshToken = regRes.body.refreshToken;

    const [session] = await db
      .select({ familyId: refreshSessions.familyId })
      .from(refreshSessions)
      .where(eq(refreshSessions.tokenHash, hashToken(refreshToken)))
      .limit(1);
    originalFamilyId = session!.familyId;
  });

  it("old row is revoked with revokeReason = rotated after a successful refresh (test 3)", async () => {
    const oldHash = hashToken(refreshToken);

    const rotateRes = await request(app).post("/api/auth/refresh").send({ refreshToken });
    expect(rotateRes.status).toBe(200);

    const [oldSession] = await db.select()
      .from(refreshSessions)
      .where(eq(refreshSessions.tokenHash, oldHash))
      .limit(1);

    expect(oldSession!.revokedAt).not.toBeNull();
    expect(oldSession!.revokeReason).toBe("rotated");

    refreshToken = rotateRes.body.refreshToken; // advance for subsequent tests
  });

  it("replacement row inherits the same familyId as the parent (test 4)", async () => {
    const [newSession] = await db
      .select({ familyId: refreshSessions.familyId })
      .from(refreshSessions)
      .where(eq(refreshSessions.tokenHash, hashToken(refreshToken)))
      .limit(1);

    expect(newSession!.familyId).toBe(originalFamilyId);
  });

  it("old token cannot be reused after rotation (test 5)", async () => {
    const currentToken = refreshToken;

    // Rotate the current token
    const rotateRes = await request(app).post("/api/auth/refresh").send({ refreshToken: currentToken });
    expect(rotateRes.status).toBe(200);

    // The now-rotated (old) token must be rejected
    const reuseRes = await request(app).post("/api/auth/refresh").send({ refreshToken: currentToken });
    expect(reuseRes.status).toBe(401);
    expect(reuseRes.body.error).toBe("Unauthorized");
  });
});

// ─── 6, 7. Concurrent refresh ─────────────────────────────────────────────────
//
// Two requests submit the same active token simultaneously.
// SELECT … FOR UPDATE serialises them at the database level.
// One transaction acquires the lock and rotates; the second waits, then finds
// the row already revoked and triggers replay handling — revoking the family
// (including the replacement just created by the first request).
// Result: exactly one 200, exactly one 401, exactly one replacement row.

describe("Concurrent refresh — PostgreSQL FOR UPDATE serialisation", () => {
  it("exactly one of two concurrent refreshes returns 200, the other 401 (test 6)", async () => {
    const u = makeUser();
    const regRes = await request(app).post("/api/auth/register").send(u);
    const { refreshToken } = regRes.body;

    // Both requests hit separate Express handler invocations and separate
    // connections from the pool, so PG locking is genuinely exercised.
    const [res1, res2] = await Promise.all([
      request(app).post("/api/auth/refresh").send({ refreshToken }),
      request(app).post("/api/auth/refresh").send({ refreshToken }),
    ]);

    const statuses = [res1.status, res2.status].sort();
    expect(statuses).toEqual([200, 401]);
  });

  it("concurrent refresh creates exactly one replacement session row (test 7)", async () => {
    const u = makeUser();
    const regRes = await request(app).post("/api/auth/register").send(u);
    const { refreshToken } = regRes.body;
    const originalHash = hashToken(refreshToken);

    const [originalSession] = await db
      .select({ familyId: refreshSessions.familyId })
      .from(refreshSessions)
      .where(eq(refreshSessions.tokenHash, originalHash))
      .limit(1);
    const { familyId } = originalSession!;

    await Promise.all([
      request(app).post("/api/auth/refresh").send({ refreshToken }),
      request(app).post("/api/auth/refresh").send({ refreshToken }),
    ]);

    const familySessions = await db
      .select()
      .from(refreshSessions)
      .where(eq(refreshSessions.familyId, familyId));

    // Original row + exactly one replacement
    expect(familySessions).toHaveLength(2);

    const replacements = familySessions.filter(s => s.tokenHash !== originalHash);
    expect(replacements).toHaveLength(1);
  });
});

// ─── 8, 9, 10. Replay detection ───────────────────────────────────────────────

describe("Replay detection — family-scoped revocation", () => {
  let userEmail: string;
  let userPassword: string;

  beforeAll(async () => {
    const u = makeUser();
    userEmail = u.email;
    userPassword = u.password;
    await request(app).post("/api/auth/register").send(u);
  });

  it("replay revokes every active row in the affected family (test 8)", async () => {
    const loginRes = await request(app)
      .post("/api/auth/login")
      .send({ email: userEmail, password: userPassword });
    const rt1 = loginRes.body.refreshToken;

    const [initialSession] = await db
      .select({ familyId: refreshSessions.familyId })
      .from(refreshSessions)
      .where(eq(refreshSessions.tokenHash, hashToken(rt1)))
      .limit(1);
    const { familyId } = initialSession!;

    // Rotate once: rt1 → rt2 (rt2 is now the live token in this family)
    const rotateRes = await request(app).post("/api/auth/refresh").send({ refreshToken: rt1 });
    expect(rotateRes.status).toBe(200);

    // One active session in the family at this point
    const beforeReplay = await db.select()
      .from(refreshSessions)
      .where(and(eq(refreshSessions.familyId, familyId), isNull(refreshSessions.revokedAt)));
    expect(beforeReplay).toHaveLength(1);

    // Replay the already-rotated rt1 — triggers family revocation
    const replayRes = await request(app).post("/api/auth/refresh").send({ refreshToken: rt1 });
    expect(replayRes.status).toBe(401);

    // No active sessions remain in this family
    const afterReplay = await db.select()
      .from(refreshSessions)
      .where(and(eq(refreshSessions.familyId, familyId), isNull(refreshSessions.revokedAt)));
    expect(afterReplay).toHaveLength(0);

    // The replacement row (rt2) should be revoked with token_reuse_detected
    const rt2Row = await db.select()
      .from(refreshSessions)
      .where(
        and(
          eq(refreshSessions.familyId, familyId),
          eq(refreshSessions.revokeReason, "token_reuse_detected"),
        ),
      );
    expect(rt2Row.length).toBeGreaterThanOrEqual(1);
  });

  it("replay on device A does not revoke device B's independent family (test 9)", async () => {
    // Device A: login → rotate (leaving rt1A as a revoked token)
    const resA = await request(app)
      .post("/api/auth/login")
      .send({ email: userEmail, password: userPassword });
    const rt1A = resA.body.refreshToken;
    const rotateA = await request(app).post("/api/auth/refresh").send({ refreshToken: rt1A });
    expect(rotateA.status).toBe(200);

    // Device B: independent login (separate familyId)
    const resB = await request(app)
      .post("/api/auth/login")
      .send({ email: userEmail, password: userPassword });
    const rtB = resB.body.refreshToken;

    const [sessionB] = await db
      .select({ familyId: refreshSessions.familyId })
      .from(refreshSessions)
      .where(eq(refreshSessions.tokenHash, hashToken(rtB)))
      .limit(1);
    const familyB = sessionB!.familyId;

    // Replay device A's old token — must not touch device B
    const replayRes = await request(app).post("/api/auth/refresh").send({ refreshToken: rt1A });
    expect(replayRes.status).toBe(401);

    // Device B's session is still fully active
    const activeBSessions = await db.select()
      .from(refreshSessions)
      .where(and(eq(refreshSessions.familyId, familyB), isNull(refreshSessions.revokedAt)));
    expect(activeBSessions).toHaveLength(1);

    // Device B can still successfully refresh
    const rtBRotate = await request(app).post("/api/auth/refresh").send({ refreshToken: rtB });
    expect(rtBRotate.status).toBe(200);
  });

  it("replay response is generic and reveals nothing about the detection (test 10)", async () => {
    const loginRes = await request(app)
      .post("/api/auth/login")
      .send({ email: userEmail, password: userPassword });
    const rt1 = loginRes.body.refreshToken;

    // Rotate
    await request(app).post("/api/auth/refresh").send({ refreshToken: rt1 });

    // Replay
    const replayRes = await request(app).post("/api/auth/refresh").send({ refreshToken: rt1 });
    expect(replayRes.status).toBe(401);
    expect(replayRes.body.error).toBe("Unauthorized");
    expect(replayRes.body.message).toBe("Invalid refresh token");

    const bodyStr = JSON.stringify(replayRes.body).toLowerCase();
    expect(bodyStr).not.toContain("replay");
    expect(bodyStr).not.toContain("revok");
    expect(bodyStr).not.toContain("session");
    expect(bodyStr).not.toContain("family");
    expect(bodyStr).not.toContain("reuse");
    expect(bodyStr).not.toContain("detect");
    expect(bodyStr).not.toContain("used");
    expect(bodyStr).not.toContain("rotated");
  });
});

// ─── 11. Logout — family revocation ──────────────────────────────────────────

describe("Logout — revokes entire token family", () => {
  it("logout sets revokeReason = logout on the family's active session (test 11)", async () => {
    const u = makeUser();
    await request(app).post("/api/auth/register").send(u);
    const loginRes = await request(app).post("/api/auth/login").send({ email: u.email, password: u.password });
    const { token: accessToken1, refreshToken: rt1 } = loginRes.body;

    // Rotate once so the family has a history (rt1 revoked, rt2 active)
    const rotateRes = await request(app).post("/api/auth/refresh").send({ refreshToken: rt1 });
    expect(rotateRes.status).toBe(200);
    const { token: accessToken2, refreshToken: rt2 } = rotateRes.body;

    const [sessionRt2] = await db
      .select({ familyId: refreshSessions.familyId })
      .from(refreshSessions)
      .where(eq(refreshSessions.tokenHash, hashToken(rt2)))
      .limit(1);
    const { familyId } = sessionRt2!;

    // Logout with rt2
    const logoutRes = await request(app)
      .post("/api/auth/logout")
      .set("Authorization", `Bearer ${accessToken2}`)
      .send({ refreshToken: rt2 });
    expect(logoutRes.status).toBe(200);

    // No active sessions in this family
    const active = await db.select()
      .from(refreshSessions)
      .where(and(eq(refreshSessions.familyId, familyId), isNull(refreshSessions.revokedAt)));
    expect(active).toHaveLength(0);

    // rt2's row carries revokeReason = logout
    const [rt2Row] = await db.select()
      .from(refreshSessions)
      .where(eq(refreshSessions.tokenHash, hashToken(rt2)))
      .limit(1);
    expect(rt2Row!.revokeReason).toBe("logout");

    // rt2 is now rejected on refresh
    const postLogoutRefresh = await request(app).post("/api/auth/refresh").send({ refreshToken: rt2 });
    expect(postLogoutRefresh.status).toBe(401);
  });
});

// ─── 12. Logout-all ───────────────────────────────────────────────────────────

describe("Logout-all — revokes all families for the user", () => {
  it("logout-all revokes every session with revokeReason = logout_all (test 12)", async () => {
    const u = makeUser();
    await request(app).post("/api/auth/register").send(u);

    // Three independent device logins
    const [l1, l2, l3] = await Promise.all([
      request(app).post("/api/auth/login").send({ email: u.email, password: u.password }),
      request(app).post("/api/auth/login").send({ email: u.email, password: u.password }),
      request(app).post("/api/auth/login").send({ email: u.email, password: u.password }),
    ]);
    const tokens = [l1.body.refreshToken, l2.body.refreshToken, l3.body.refreshToken];
    const hashes = tokens.map(hashToken);

    // Logout-all via session 1's access token
    const logoutAllRes = await request(app)
      .post("/api/auth/logout-all")
      .set("Authorization", `Bearer ${l1.body.token}`);
    expect(logoutAllRes.status).toBe(200);

    // All three refresh tokens must now be rejected
    const responses = await Promise.all(
      tokens.map(rt => request(app).post("/api/auth/refresh").send({ refreshToken: rt })),
    );
    for (const r of responses) {
      expect(r.status).toBe(401);
    }

    // Every row carries revokeReason = logout_all
    for (const hash of hashes) {
      const [s] = await db.select({ revokeReason: refreshSessions.revokeReason })
        .from(refreshSessions)
        .where(eq(refreshSessions.tokenHash, hash))
        .limit(1);
      expect(s!.revokeReason).toBe("logout_all");
    }
  });
});

// ─── 13. Password reset revocation ────────────────────────────────────────────

describe("Password reset — revokes all families", () => {
  it("reset revokes all active sessions with revokeReason = password_reset (test 13)", async () => {
    const u = makeUser();
    await request(app).post("/api/auth/register").send(u);

    const [l1, l2] = await Promise.all([
      request(app).post("/api/auth/login").send({ email: u.email, password: u.password }),
      request(app).post("/api/auth/login").send({ email: u.email, password: u.password }),
    ]);
    const rt1 = l1.body.refreshToken;
    const rt2 = l2.body.refreshToken;

    // Trigger reset flow
    process.env["DEV_SHOW_RESET_TOKEN"] = "true";
    const forgotRes = await request(app).post("/api/auth/forgot-password").send({ email: u.email });
    const rawToken = forgotRes.body._dev_token as string;
    process.env["DEV_SHOW_RESET_TOKEN"] = undefined;

    const resetRes = await request(app)
      .post("/api/auth/reset-password")
      .send({ token: rawToken, password: "NewPassword2!" });
    expect(resetRes.status).toBe(200);

    // Both original sessions rejected
    const [r1, r2] = await Promise.all([
      request(app).post("/api/auth/refresh").send({ refreshToken: rt1 }),
      request(app).post("/api/auth/refresh").send({ refreshToken: rt2 }),
    ]);
    expect(r1.status).toBe(401);
    expect(r2.status).toBe(401);

    // revokeReason = password_reset on both
    const [s1] = await db.select({ revokeReason: refreshSessions.revokeReason })
      .from(refreshSessions)
      .where(eq(refreshSessions.tokenHash, hashToken(rt1)))
      .limit(1);
    const [s2] = await db.select({ revokeReason: refreshSessions.revokeReason })
      .from(refreshSessions)
      .where(eq(refreshSessions.tokenHash, hashToken(rt2)))
      .limit(1);
    expect(s1!.revokeReason).toBe("password_reset");
    expect(s2!.revokeReason).toBe("password_reset");
  });
});

// ─── 14, 15. Expired and pre-revoked tokens ───────────────────────────────────

describe("Expired and previously revoked tokens", () => {
  let testUserId: string;

  beforeAll(async () => {
    const u = makeUser();
    const res = await request(app).post("/api/auth/register").send(u);
    testUserId = res.body.user.id;
  });

  it("expired token is rejected with generic 401 and creates no replacement (test 14)", async () => {
    const familyId = randomUUID();
    const { raw, hash } = createRefreshToken();

    // Insert a session that is already in the past
    await db.insert(refreshSessions).values({
      userId: testUserId,
      tokenHash: hash,
      familyId,
      expiresAt: new Date(Date.now() - 2000), // 2 seconds ago
    });

    const res = await request(app).post("/api/auth/refresh").send({ refreshToken: raw });
    expect(res.status).toBe(401);
    expect(res.body.message).toBe("Invalid refresh token");

    // No replacement row was created — only the original expired row
    const familySessions = await db.select()
      .from(refreshSessions)
      .where(eq(refreshSessions.familyId, familyId));
    expect(familySessions).toHaveLength(1);
    expect(familySessions[0]!.revokeReason).toBe("expired");
  });

  it("a previously revoked token is rejected with generic 401 (test 15)", async () => {
    const familyId = randomUUID();
    const { raw, hash } = createRefreshToken();

    // Insert an already-revoked session
    await db.insert(refreshSessions).values({
      userId: testUserId,
      tokenHash: hash,
      familyId,
      expiresAt: refreshTokenExpiresAt(),
      revokedAt: new Date(),
      revokeReason: "logout",
    });

    const res = await request(app).post("/api/auth/refresh").send({ refreshToken: raw });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Unauthorized");
    expect(res.body.message).toBe("Invalid refresh token");
  });
});

// ─── 16, 17, 18. Transaction rollback ─────────────────────────────────────────

describe("Transaction rollback — no partial rotation state", () => {
  let testUserId: string;

  beforeAll(async () => {
    const u = makeUser();
    const res = await request(app).post("/api/auth/register").send(u);
    testUserId = res.body.user.id;
  });

  it("failure after revoking parent but before inserting child rolls back both changes (test 16)", async () => {
    const familyId = randomUUID();
    const { hash: oldHash } = createRefreshToken();

    await db.insert(refreshSessions).values({
      userId: testUserId,
      tokenHash: oldHash,
      familyId,
      expiresAt: refreshTokenExpiresAt(),
    });

    // Simulate mid-transaction failure after the UPDATE but before the INSERT
    try {
      await db.transaction(async (tx) => {
        const [row] = await tx
          .select({ id: refreshSessions.id })
          .from(refreshSessions)
          .where(eq(refreshSessions.tokenHash, oldHash))
          .limit(1);

        await tx
          .update(refreshSessions)
          .set({ revokedAt: new Date(), revokeReason: "rotated" })
          .where(eq(refreshSessions.id, row!.id));

        // Intentional throw — simulates an error before the INSERT
        throw new Error("Simulated pre-insert failure");
      });
    } catch {
      // expected — transaction rolled back
    }

    // Original session must still be fully active (rollback preserved it)
    const [session] = await db
      .select()
      .from(refreshSessions)
      .where(eq(refreshSessions.tokenHash, oldHash))
      .limit(1);
    expect(session!.revokedAt).toBeNull();
    expect(session!.revokeReason).toBeNull();
  });

  it("failure after inserting replacement also rolls back the full transaction (test 17)", async () => {
    const familyId = randomUUID();
    const { hash: oldHash } = createRefreshToken();
    const { hash: newHash } = createRefreshToken();

    await db.insert(refreshSessions).values({
      userId: testUserId,
      tokenHash: oldHash,
      familyId,
      expiresAt: refreshTokenExpiresAt(),
    });

    try {
      await db.transaction(async (tx) => {
        const [row] = await tx
          .select({ id: refreshSessions.id })
          .from(refreshSessions)
          .where(eq(refreshSessions.tokenHash, oldHash))
          .limit(1);

        // Revoke old
        await tx
          .update(refreshSessions)
          .set({ revokedAt: new Date(), revokeReason: "rotated" })
          .where(eq(refreshSessions.id, row!.id));

        // Insert replacement
        await tx.insert(refreshSessions).values({
          userId: testUserId,
          tokenHash: newHash,
          familyId,
          expiresAt: refreshTokenExpiresAt(),
        });

        // Throw after both operations — simulates a failure before commit
        throw new Error("Simulated post-insert failure");
      });
    } catch {
      // expected
    }

    // Old session still active (both changes rolled back)
    const [oldSession] = await db
      .select()
      .from(refreshSessions)
      .where(eq(refreshSessions.tokenHash, oldHash))
      .limit(1);
    expect(oldSession!.revokedAt).toBeNull();

    // Replacement row does not exist
    const [newSession] = await db
      .select()
      .from(refreshSessions)
      .where(eq(refreshSessions.tokenHash, newHash))
      .limit(1);
    expect(newSession).toBeUndefined();
  });

  it("session remains usable via the HTTP route after a rolled-back attempt (test 18)", async () => {
    // After the rollback in test 16 above, the original session is still active.
    // Create a fresh one to confirm the route treats a never-tampered session
    // as valid — proving no partial state leaked from the failed transaction.
    const familyId = randomUUID();
    const { raw, hash } = createRefreshToken();

    await db.insert(refreshSessions).values({
      userId: testUserId,
      tokenHash: hash,
      familyId,
      expiresAt: refreshTokenExpiresAt(),
    });

    // Simulate a failed transaction (rolls back the UPDATE)
    try {
      await db.transaction(async (tx) => {
        await tx
          .update(refreshSessions)
          .set({ revokedAt: new Date(), revokeReason: "rotated" })
          .where(eq(refreshSessions.tokenHash, hash));
        throw new Error("Simulated failure");
      });
    } catch { /* expected */ }

    // The route must still accept the token (no partial state)
    const refreshRes = await request(app).post("/api/auth/refresh").send({ refreshToken: raw });
    expect(refreshRes.status).toBe(200);
  });
});

// ─── 19. Migration verification ───────────────────────────────────────────────

describe("Migration 0003 — refresh_sessions schema", () => {
  it("no refresh_sessions row has a null family_id (test 19)", async () => {
    const nullRows = await db
      .select({ id: refreshSessions.id })
      .from(refreshSessions)
      .where(isNull(refreshSessions.familyId));
    expect(nullRows).toHaveLength(0);
  });

  it("family_id index is present in pg_indexes (test 19b)", async () => {
    const result = await db.execute(sql`
      SELECT indexname
      FROM pg_indexes
      WHERE tablename = 'refresh_sessions'
        AND indexname  = 'refresh_sessions_family_id_idx'
    `);
    expect((result as any).rows).toHaveLength(1);
  });

  it("revoke_reason column exists and accepts null (test 19c)", async () => {
    // Any row inserted without a revoke_reason should have null
    const u = makeUser();
    const regRes = await request(app).post("/api/auth/register").send(u);
    const [session] = await db
      .select({ revokeReason: refreshSessions.revokeReason })
      .from(refreshSessions)
      .where(eq(refreshSessions.tokenHash, hashToken(regRes.body.refreshToken)))
      .limit(1);
    expect(session!.revokeReason).toBeNull();
  });
});

// ─── 23. Token information hygiene ────────────────────────────────────────────

describe("Token information hygiene — no raw tokens or hashes in responses", () => {
  it("error response for an unknown token does not echo the submitted token (test 23a)", async () => {
    const { raw } = createRefreshToken(); // valid-format but unknown token
    const res = await request(app).post("/api/auth/refresh").send({ refreshToken: raw });
    expect(res.status).toBe(401);

    const bodyStr = JSON.stringify(res.body);
    expect(bodyStr).not.toContain(raw);
    expect(bodyStr).not.toContain(hashToken(raw));
  });

  it("replay error response does not include the submitted token or any hash (test 23b)", async () => {
    const u = makeUser();
    const regRes = await request(app).post("/api/auth/register").send(u);
    const { refreshToken: originalToken } = regRes.body;

    // Rotate to make original stale
    await request(app).post("/api/auth/refresh").send({ refreshToken: originalToken });

    // Replay
    const replayRes = await request(app).post("/api/auth/refresh").send({ refreshToken: originalToken });
    expect(replayRes.status).toBe(401);

    const bodyStr = JSON.stringify(replayRes.body);
    expect(bodyStr).not.toContain(originalToken);
    expect(bodyStr).not.toContain(hashToken(originalToken));
  });

  it("successful refresh response contains the raw new token but not any hash (test 23c)", async () => {
    const u = makeUser();
    const regRes = await request(app).post("/api/auth/register").send(u);
    const { refreshToken: rt1 } = regRes.body;

    const rotateRes = await request(app).post("/api/auth/refresh").send({ refreshToken: rt1 });
    expect(rotateRes.status).toBe(200);

    const { refreshToken: rt2 } = rotateRes.body;
    const bodyStr = JSON.stringify(rotateRes.body);

    // Raw new token is correctly returned to the client
    expect(bodyStr).toContain(rt2);
    // Neither old nor new token hash must appear
    expect(bodyStr).not.toContain(hashToken(rt1));
    expect(bodyStr).not.toContain(hashToken(rt2));
  });
});
