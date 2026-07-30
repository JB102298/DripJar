/**
 * Concurrency connection proof for Task 4 final verification.
 *
 * Proves that concurrent refresh genuinely exercises PostgreSQL row locking
 * across SEPARATE database connections (distinct backend PIDs), rather than
 * being serialised inside a single connection.
 *
 * Two layers of proof:
 *
 *  A. HTTP layer — two concurrent POST /api/auth/refresh requests with the
 *     same token. The pg Pool's "acquire" events record client.processID
 *     (the PostgreSQL backend PID established at connection startup) for
 *     every connection handed out during the concurrent window. We assert
 *     that at least two DISTINCT backend PIDs were acquired concurrently,
 *     one response is 200, one is 401, and exactly one replacement row
 *     exists.
 *
 *  B. Direct SQL layer — two dedicated pool connections replicate the exact
 *     locking pattern of the refresh route (SELECT … FOR UPDATE on the same
 *     session row). Each records SELECT pg_backend_pid(). Connection A locks
 *     the row, revokes it, and commits while connection B is provably
 *     blocked waiting on the row lock; B then observes the COMMITTED revoked
 *     state. PIDs are asserted different.
 *
 * No raw tokens are logged. Only backend PIDs and row ids are recorded.
 */

import { describe, it, expect } from "vitest";
import request from "supertest";
import type { PoolClient } from "pg";
import { db, pool, refreshSessions } from "@workspace/db";
import { eq } from "drizzle-orm";
import { hashToken } from "../lib/auth.js";
import app from "../app.js";

const makeUser = () => {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return {
    email: `ccp-${id}@example.com`,
    password: "Password1!",
    firstName: "CC",
    lastName: "Proof",
  };
};

describe("Concurrency connection proof — separate PostgreSQL backends", () => {
  it("A. concurrent HTTP refreshes use distinct backend PIDs; one 200 / one 401 / one replacement", async () => {
    const u = makeUser();
    const regRes = await request(app).post("/api/auth/register").send(u);
    expect(regRes.status).toBe(201);
    const { refreshToken } = regRes.body;
    const originalHash = hashToken(refreshToken);

    const [originalSession] = await db
      .select({ id: refreshSessions.id, familyId: refreshSessions.familyId })
      .from(refreshSessions)
      .where(eq(refreshSessions.tokenHash, originalHash))
      .limit(1);
    expect(originalSession).toBeDefined();

    // Record backend PIDs of every pool connection acquired during the
    // concurrent window. pg exposes the backend PID negotiated at connection
    // startup as client.processID — no extra query, no token exposure.
    const acquiredPids: number[] = [];
    const onAcquire = (client: PoolClient) => {
      const pid = (client as unknown as { processID?: number }).processID;
      if (typeof pid === "number") acquiredPids.push(pid);
    };
    pool.on("acquire", onAcquire);

    let res1, res2;
    try {
      [res1, res2] = await Promise.all([
        request(app).post("/api/auth/refresh").send({ refreshToken }),
        request(app).post("/api/auth/refresh").send({ refreshToken }),
      ]);
    } finally {
      pool.removeListener("acquire", onAcquire);
    }

    // Exactly one 200 and one 401.
    expect([res1.status, res2.status].sort()).toEqual([200, 401]);

    // Both transactions ran during the window; a transaction pins its
    // connection, so two overlapping transactions REQUIRE two distinct
    // backends. Assert we saw at least two distinct PIDs acquired.
    const distinctPids = [...new Set(acquiredPids)];
    expect(distinctPids.length).toBeGreaterThanOrEqual(2);

    // Both requests targeted the same original row: it is now revoked.
    const [after] = await db
      .select({ revokedAt: refreshSessions.revokedAt })
      .from(refreshSessions)
      .where(eq(refreshSessions.id, originalSession!.id))
      .limit(1);
    expect(after!.revokedAt).not.toBeNull();

    // Exactly one replacement row in the family.
    const familyRows = await db
      .select({ tokenHash: refreshSessions.tokenHash })
      .from(refreshSessions)
      .where(eq(refreshSessions.familyId, originalSession!.familyId));
    expect(familyRows).toHaveLength(2);
    expect(familyRows.filter(r => r.tokenHash !== originalHash)).toHaveLength(1);
  });

  it("B. direct two-connection FOR UPDATE proof — distinct PIDs, blocked waiter observes committed revoked state", async () => {
    const u = makeUser();
    const regRes = await request(app).post("/api/auth/register").send(u);
    expect(regRes.status).toBe(201);
    const sessionHash = hashToken(regRes.body.refreshToken);

    const [row] = await db
      .select({ id: refreshSessions.id })
      .from(refreshSessions)
      .where(eq(refreshSessions.tokenHash, sessionHash))
      .limit(1);
    const rowId = row!.id;

    const connA = await pool.connect();
    const connB = await pool.connect();
    try {
      const pidA: number = (await connA.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      const pidB: number = (await connB.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;

      // Separate connections ⇒ separate PostgreSQL backends.
      expect(pidA).not.toBe(pidB);

      // Transaction A: lock the session row (same pattern as the route).
      await connA.query("BEGIN");
      const lockA = await connA.query(
        `SELECT id, revoked_at FROM refresh_sessions WHERE id = $1 FOR UPDATE`,
        [rowId],
      );
      expect(lockA.rows).toHaveLength(1);
      expect(lockA.rows[0].revoked_at).toBeNull();

      // Transaction B: attempt the same lock — must block until A commits.
      let bCompleted = false;
      const bPromise = (async () => {
        await connB.query("BEGIN");
        const lockB = await connB.query(
          `SELECT id, revoked_at FROM refresh_sessions WHERE id = $1 FOR UPDATE`,
          [rowId],
        );
        bCompleted = true;
        await connB.query("COMMIT");
        return lockB.rows[0];
      })();

      // Poll pg_locks until B's backend is provably waiting on a lock
      // (granted = false). Polling avoids fixed-sleep timing flakiness.
      let bIsWaiting = false;
      const deadline = Date.now() + 5000;
      while (!bIsWaiting && Date.now() < deadline) {
        const waiting = await connA.query(
          `SELECT count(*)::int AS n FROM pg_locks
           WHERE pid = $1 AND granted = false`,
          [pidB],
        );
        bIsWaiting = waiting.rows[0].n >= 1;
        if (!bIsWaiting) await new Promise(r => setTimeout(r, 25));
      }
      expect(bIsWaiting).toBe(true);
      expect(bCompleted).toBe(false); // still blocked while A holds the lock

      // A revokes the row and commits (the route's "rotation" write).
      await connA.query(
        `UPDATE refresh_sessions
         SET revoked_at = now(), revoke_reason = 'rotated'
         WHERE id = $1`,
        [rowId],
      );
      await connA.query("COMMIT");

      // B unblocks and must observe the COMMITTED revoked state.
      const seenByB = await bPromise;
      expect(bCompleted).toBe(true);
      expect(seenByB.revoked_at).not.toBeNull();
    } finally {
      try { await connA.query("ROLLBACK"); } catch { /* already committed */ }
      try { await connB.query("ROLLBACK"); } catch { /* already committed */ }
      connA.release();
      connB.release();
    }
  });
});
