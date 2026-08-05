---
name: Webhook concurrency patterns
description: Exactly-once Stripe webhook processing — three production bugs fixed in Phase 4B; correct patterns going forward.
---

# Webhook Exactly-Once Concurrency Patterns

## The three bugs (all fixed)

**Bug 1 — Unique constraint throws, not returns empty**
Drizzle's `insert().values().returning()` throws on unique constraint violation; it does NOT return an empty array. Without `.onConflictDoNothing()`, concurrent deliveries of the same event ID all get a 500 after the first insert wins.

**Why:** PostgreSQL raises an exception on constraint violation — the driver propagates it.

**How to apply:** Always add `.onConflictDoNothing()` before `.returning()` on any idempotency-keyed INSERT; the `!inserted` check then works correctly for the race re-read path.

---

**Bug 2 — Drizzle subquery via `.then()` produces `[object Promise]`**
Using `.then()` on a Drizzle query to compute a SET value attaches the Promise as the parameter. Drizzle calls `.toString()` on it → `[object Promise]` is sent to Postgres.

**Why:** Drizzle does not unwrap Promises inside `.set({})`; it serialises whatever you pass.

**How to apply:** Use `sql\`${table.col} + 1\`` (imported from drizzle-orm) for any arithmetic increment in a SET clause. Never use `.then()` inside `.set({})`.

---

**Bug 3 — Event row stuck in 'processing' after concurrent delivery**
The "mark event as processing" UPDATE runs outside the FOR UPDATE transaction. If a late worker issues this UPDATE after the winner's transaction has already written "processed", the row regresses. The skip branch inside the transaction returned without marking "processed".

**Why:** The processing UPDATE and the processed UPDATE are not atomic with respect to each other — they're in different DB statements separated by async I/O.

**How to apply:** In every transaction exit path (including the "already posted by concurrent worker" early-return), write `UPDATE stripeWebhookEvents SET processingStatus = 'processed'`. This is idempotent and guarantees the last transaction writer always leaves the row in "processed".

---

## Stress test design notes

- Pool-exhaustion timeout: with `singleFork: true` vitest config and 20+ concurrent requests per scenario, the three describe-block setups (beforeAll API calls) compete with the in-flight transactions for the DB connection pool. Keep concurrent request count ≤ 10 per scenario to avoid timeout cascades.
- Counter-based mock dispatch: `let i = 0; mock.mockImplementation(() => i++ % 2 === 0 ? eventA : eventB)` is safe in Node.js (single-threaded); no need to parse `rawBody` inside the mock.
- Always add explicit `beforeAll(fn, 60_000)` and `it("...", { timeout: 120_000 }, fn)` to any describe block that fires concurrent DB transactions.
- `reconcileActualFee` is fire-and-forget — its failures are silently swallowed. Do not rely on it for correctness; any test that checks fee accuracy must wait for it or mock it.
