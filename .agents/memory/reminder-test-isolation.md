---
name: Reminder test isolation
description: How to fix reminder-deduplication test flakiness caused by shared-DB accumulation across test runs.
---

## Rule
Any describe block that asserts `secondSent === 0` (i.e., calls process-reminders twice and expects the second call to produce zero new events) MUST flush accumulated events to terminal state in its `beforeAll` by calling process-reminders once before the assertions run.

## Why
The dedup test calls POST /internal/process-reminders twice and asserts the second call returns zero newly-sent events. With `singleFork: true` in vitest config (tests run sequentially, no cross-file concurrency), the failure is caused purely by DB accumulation across test suite runs: earlier describe blocks create jars/agreements that are never cleaned up, and those jars' events may be in non-terminal state when the idempotency describe block starts.

In NODE_ENV=test, `reminder-email.ts` returns vacuous-success for every send attempt, so a single processor run always drains every pending/failed row to `sent` or `skipped_preference`. Adding a flush call in `beforeAll` guarantees a deterministic starting state.

## How to apply
In each describe block that contains a `secondSent === 0` dedup assertion, add to `beforeAll`:

```typescript
beforeAll(async () => {
  process.env["INTERNAL_REMINDER_TOKEN"] = INTERNAL_TOKEN;
  // Flush all accumulated reminder events to terminal state.
  // In NODE_ENV=test emails return vacuous-success; one run drains everything.
  await request(app)
    .post(`${BASE}/internal/process-reminders`)
    .set("X-Internal-Token", INTERNAL_TOKEN);
});
```

Currently applied to two describe blocks in phase3-automation.test.ts:
- "Reminder processor idempotency"
- "Email delivery state tracking (Part 4)"

## Additional context
- The vitest config uses `pool: "forks", singleFork: true` — all test files run in the SAME process, sequentially. No cross-file concurrency.
- The reminder processor is global (processes ALL jars) and must NOT be scoped for tests.
- @types/pg must be in api-server devDependencies (^8.20.0) for the concurrency proof test to typecheck.
