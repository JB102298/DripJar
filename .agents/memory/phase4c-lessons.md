---
name: Phase 4C verification lessons
description: Dev-DB accumulated test data causes spurious timeouts in full-suite runs; patterns for fixing without changing production logic.
---

# Phase 4C Verification Session Lessons

## Accumulated test data slows reminder processor
The reminder processor scans ALL jars with `status='Saving'`. After many test runs in the shared dev DB, thousands of old Saving jars accumulate, making each `POST /api/process-reminders` call take ~35 s instead of ~3 s.

**Why:** The processor queries `FROM jars WHERE status='Saving'` — no time filter.

**How to apply:** Before running phase3-automation (or any reminder-heavy suite) against the shared dev DB, update old test jars: `UPDATE jars SET status='Completed' WHERE status='Saving' AND created_at < now() - interval '2 hours'`. This is CI-equivalent (fresh DB per run) and safe for dev-only test rows.

---

## Webhook concurrency Scenario A borderline timeout
`phase4b-webhook-concurrency.test.ts` Scenario A fires 20 concurrent real-signature webhook requests. Under full-suite load (17 files sequentially, singleFork:true), it consistently takes ~120 s, right at its prior 120 000 ms limit.

**Why:** Prior test files saturate the DB connection pool; each concurrent request queues slightly longer than in a standalone run.

**How to apply:** Scenario A timeout should be 180 000 ms (not 120 000 ms). Scenarios B and C need `await waitForPoolConnections(5, 30_000)` at the start of their `beforeAll` hooks (matching Scenario A's existing pattern) to prevent cascade failure if A finishes late.

---

## Background processes die between ShellExec calls
In this Replit environment, background processes started with `&` (including `disown`, `setsid`) are killed when the parent ShellExec shell exits. Vitest output is buffered until process completion, so only startup lines appear in log files before the process dies.

**Why:** Container process-group cleanup kills all children when the orchestrating shell exits, regardless of `disown` or `setsid`.

**How to apply:** For long-running test suites (>5 min), the only reliable strategy is:
1. Clean up DB state to bring the suite under the 300 s ShellExec limit, OR
2. Use `--reporter=verbose` to see per-test output (but still can't survive shell exit).

---

## REFUND_PENDING migration verification: use `code` not `account_type`
Migration 0012 inserts `code='REFUND_PENDING', account_type='liability'`. A verification query using `WHERE account_type='REFUND_PENDING'` returns 0 rows (wrong column). Must use `WHERE code='REFUND_PENDING'`.
