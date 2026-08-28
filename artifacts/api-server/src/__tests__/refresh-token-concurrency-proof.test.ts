/**
 * Concurrency proof for refresh-token rotation.
 *
 * The invariant under test is a product contract: two refresh attempts using
 * the same token can never both rotate it, and whatever state the race leaves
 * behind must be the state the replay design specifies.
 *
 * Two layers of proof:
 *
 *  A. HTTP layer — two concurrent POST /api/auth/refresh with the same token.
 *     Exactly one 200 and one 401, and the resulting rows say *why*: the
 *     original session is revoked as 'rotated' by the winner, and the
 *     replacement the winner issued is revoked as 'token_reuse_detected' by
 *     the loser. That second reason is what makes this a concurrency proof —
 *     it can only be written by a request that found the row already rotated,
 *     which means the two attempts contended for the same row and the lock
 *     serialised them. The winner's new token is then rejected, because the
 *     replay response revoked the whole family.
 *
 *  B. Direct SQL layer — two dedicated pool connections replicate the route's
 *     locking pattern (SELECT … FOR UPDATE on the same session row).
 *     Connection A locks the row, revokes it, and commits while B is *provably*
 *     blocked — established by polling `pg_locks` for an ungranted lock held by
 *     B's backend, not by sleeping and hoping. B then observes the committed
 *     revoked state.
 *
 * ─── WHY NO BACKEND-PID ASSERTION ────────────────────────────────────────────
 *
 * This file used to assert that the concurrent window acquired at least two
 * distinct PostgreSQL backend PIDs, read from the pool's "acquire" events.
 * That is not a product contract — nothing in DripJar promises which backend
 * serves a request — and it is not reliably true either: if one request
 * finishes with its connection before the other acquires, the pool hands back
 * the same client and the same PID, and the assertion fails on a suite that is
 * behaving perfectly. Connection topology was standing in for the thing that
 * actually matters, which is the row state above.
 *
 * `pg_backend_pid()` still appears in layer B, but as a lookup key for
 * `pg_locks` — identifying which backend to inspect — never as an assertion.
 *
 * No raw tokens are logged. Only row ids and revocation reasons are recorded.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db, pool, refreshSessions } from "@workspace/db";
import { eq } from "drizzle-orm";
import { hashToken } from "../lib/auth.js";
import app from "../app.js";
import {
  captureOrphanBaseline,
  createFixtureTag,
  teardownFixtures,
  type OrphanBaseline,
} from "./support/fixtures.js";

const FIXTURES = createFixtureTag("ccproof");

let orphanBaseline: OrphanBaseline;

beforeAll(async () => {
  orphanBaseline = await captureOrphanBaseline();
});

afterAll(async () => {
  await teardownFixtures(FIXTURES, { baseline: orphanBaseline });
});

const makeUser = () => ({
  email: FIXTURES.email("ccp"),
  password: "Password1!",
  firstName: "CC",
  lastName: "Proof",
});

/** Register and return the session row the issued refresh token points at. */
async function registerWithSession() {
  const u = makeUser();
  const regRes = await request(app).post("/api/auth/register").send(u);
  expect(regRes.status, JSON.stringify(regRes.body)).toBe(201);

  const refreshToken = regRes.body.refreshToken as string;
  const tokenHash = hashToken(refreshToken);

  const [session] = await db
    .select({ id: refreshSessions.id, familyId: refreshSessions.familyId })
    .from(refreshSessions)
    .where(eq(refreshSessions.tokenHash, tokenHash))
    .limit(1);
  expect(session, "registration did not create a refresh session").toBeDefined();

  return { refreshToken, tokenHash, session: session! };
}

describe("Concurrent refresh rotation — exactly one rotation, family state correct", () => {
  it("A. two concurrent refreshes: one 200, one 401, and the row state names the race", async () => {
    const { refreshToken, tokenHash, session } = await registerWithSession();

    const [res1, res2] = await Promise.all([
      request(app).post("/api/auth/refresh").send({ refreshToken }),
      request(app).post("/api/auth/refresh").send({ refreshToken }),
    ]);

    // Exactly one attempt rotated. This is the contract.
    expect([res1.status, res2.status].sort()).toEqual([200, 401]);

    const winner = res1.status === 200 ? res1 : res2;
    expect(typeof winner.body.token, "winner must receive an access token").toBe("string");
    expect(typeof winner.body.refreshToken, "winner must receive a refresh token").toBe("string");

    // ── Family state ────────────────────────────────────────────────────────
    const family = await db
      .select({
        id: refreshSessions.id,
        tokenHash: refreshSessions.tokenHash,
        revokedAt: refreshSessions.revokedAt,
        revokeReason: refreshSessions.revokeReason,
      })
      .from(refreshSessions)
      .where(eq(refreshSessions.familyId, session.familyId));

    // The original plus exactly one replacement — never two replacements,
    // which is what a double rotation would have produced.
    expect(family, "expected the original session and exactly one replacement").toHaveLength(2);

    const original = family.find((r) => r.id === session.id);
    const replacement = family.find((r) => r.id !== session.id);
    expect(original).toBeDefined();
    expect(replacement).toBeDefined();
    expect(replacement!.tokenHash).not.toBe(tokenHash);
    expect(replacement!.tokenHash).toBe(hashToken(winner.body.refreshToken as string));

    // The winner rotated the original.
    expect(original!.revokedAt).not.toBeNull();
    expect(original!.revokeReason).toBe("rotated");

    // The loser found it already rotated and revoked the family. Only a request
    // that contended for this row could have written this reason, so the row
    // itself is the evidence that the two attempts raced.
    expect(replacement!.revokedAt, "replay response must revoke the replacement").not.toBeNull();
    expect(replacement!.revokeReason).toBe("token_reuse_detected");

    // Session state is therefore correct end-to-end: the token the winner was
    // handed is dead, so the client must re-authenticate.
    const reuse = await request(app)
      .post("/api/auth/refresh")
      .send({ refreshToken: winner.body.refreshToken });
    expect(reuse.status, "the revoked replacement must not refresh").toBe(401);
  });

  it("A2. an uncontended refresh rotates cleanly — the 401 above is the race, not the norm", async () => {
    const { refreshToken, session } = await registerWithSession();

    const res = await request(app).post("/api/auth/refresh").send({ refreshToken });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const family = await db
      .select({
        id: refreshSessions.id,
        revokedAt: refreshSessions.revokedAt,
        revokeReason: refreshSessions.revokeReason,
      })
      .from(refreshSessions)
      .where(eq(refreshSessions.familyId, session.familyId));

    expect(family).toHaveLength(2);
    const original = family.find((r) => r.id === session.id)!;
    const replacement = family.find((r) => r.id !== session.id)!;

    expect(original.revokeReason).toBe("rotated");
    // Nothing revoked the replacement, so replay detection did not fire — which
    // is what distinguishes this from the concurrent case above.
    expect(replacement.revokedAt).toBeNull();
    expect(replacement.revokeReason).toBeNull();
  });

  it("B. direct two-connection FOR UPDATE proof — the waiter is provably blocked, then sees the commit", async () => {
    const { session } = await registerWithSession();
    const rowId = session.id;

    const connA = await pool.connect();
    const connB = await pool.connect();
    try {
      // Used to locate B's rows in pg_locks below. Not an assertion: which
      // backend serves a connection is not part of any product contract.
      const pidB: number = (await connB.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;

      // Transaction A: lock the session row (same pattern as the route).
      await connA.query("BEGIN");
      const lockA = await connA.query(
        `SELECT id, revoked_at, revoke_reason FROM refresh_sessions WHERE id = $1 FOR UPDATE`,
        [rowId],
      );
      expect(lockA.rows).toHaveLength(1);
      expect(lockA.rows[0].revoked_at).toBeNull();

      // Transaction B: attempt the same lock — must block until A commits.
      let bCompleted = false;
      const bPromise = (async () => {
        await connB.query("BEGIN");
        const lockB = await connB.query(
          `SELECT id, revoked_at, revoke_reason FROM refresh_sessions WHERE id = $1 FOR UPDATE`,
          [rowId],
        );
        bCompleted = true;
        await connB.query("COMMIT");
        return lockB.rows[0];
      })();

      // Poll pg_locks until B's backend is provably waiting on a lock
      // (granted = false). This is a condition, not a duration: the test does
      // not proceed on a guess about how long the lock takes to register.
      let bIsWaiting = false;
      const deadline = Date.now() + 5000;
      while (!bIsWaiting && Date.now() < deadline) {
        const waiting = await connA.query(
          `SELECT count(*)::int AS n FROM pg_locks WHERE pid = $1 AND granted = false`,
          [pidB],
        );
        bIsWaiting = waiting.rows[0].n >= 1;
        if (!bIsWaiting) await new Promise((r) => setTimeout(r, 25));
      }
      expect(bIsWaiting, "B never registered as waiting on the row lock").toBe(true);
      expect(bCompleted, "B completed while A still held the lock").toBe(false);

      // A revokes the row and commits (the route's "rotation" write).
      await connA.query(
        `UPDATE refresh_sessions
         SET revoked_at = now(), revoke_reason = 'rotated'
         WHERE id = $1`,
        [rowId],
      );
      await connA.query("COMMIT");

      // B unblocks and must observe the COMMITTED revoked state — the read that
      // makes a second rotation impossible.
      const seenByB = await bPromise;
      expect(bCompleted).toBe(true);
      expect(seenByB.revoked_at).not.toBeNull();
      expect(seenByB.revoke_reason).toBe("rotated");
    } finally {
      try { await connA.query("ROLLBACK"); } catch { /* already committed */ }
      try { await connB.query("ROLLBACK"); } catch { /* already committed */ }
      connA.release();
      connB.release();
    }
  });
});
