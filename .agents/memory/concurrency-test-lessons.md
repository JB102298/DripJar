---
name: Concurrency test lessons
description: Pitfalls discovered when writing concurrent-safe DB tests with vitest + shared PostgreSQL
---

## vi.hoisted required for vi.mock factories

`vi.mock()` factories are hoisted to before all module-level code. Plain `let` / `const` variables declared at module scope are NOT initialised when the factory runs, so referencing them inside the factory produces `undefined`. Fix:

```typescript
// WRONG — mockEmailSend is undefined inside the factory
const mockEmailSend = vi.fn();
vi.mock("resend", () => ({ Resend: vi.fn().mockImplementation(() => ({ emails: { send: mockEmailSend } })) }));

// CORRECT — vi.hoisted() runs before the factory
const mockEmailSend = vi.hoisted(() => vi.fn().mockResolvedValue({ data: { id: "ok" }, error: null }));
vi.mock("resend", () => ({ Resend: vi.fn().mockImplementation(function(this: any) { this.emails = { send: mockEmailSend }; }) }));
```

## Arrow functions cannot be used as constructors in mocks

When the mocked module exports a class used with `new`, the `mockImplementation` callback MUST be a regular function (not an arrow function), so that `new MockClass(...)` can set `this`:

```typescript
// WRONG — arrow function cannot be a constructor
Resend: vi.fn().mockImplementation(() => ({ emails: { send: mockSend } }))

// CORRECT — regular function, `this` is the new instance
Resend: vi.fn().mockImplementation(function(this: any) { this.emails = { send: mockSend }; })
```

## Parallel vitest files share the same PostgreSQL DB — avoid HTTP processor calls in concurrency tests

Vitest runs test files in separate worker threads (each with its own `process.env`), but all workers connect to the same PostgreSQL database. If one test file calls a full HTTP endpoint (like `POST /internal/process-reminders`) that reads and writes ALL rows in a shared table, it mutates state that other parallel test files depend on.

**Why:** the reminder processor processes every active jar/schedule/member it finds. When `phase3-concurrency.test.ts` calls the processor, it finds and processes events belonging to jars created by `phase3-automation.test.ts`, interfering with that file's idempotency assertions.

**Fix:** DB-direct tests (insert/update via drizzle + `atomicClaimEmailAttempt`) are isolated to their own rows (unique event_keys). They never touch other test files' data. Full-processor idempotency should be tested in exactly ONE file (`phase3-automation.test.ts`).

## Atomic claim pattern for concurrent email delivery

```sql
UPDATE reminder_sent_events
SET email_status = 'sending',
    email_attempt_count = email_attempt_count + 1,
    email_last_attempt_at = now()
WHERE id = ?
  AND (
    email_status IN ('pending', 'failed')
    OR (email_status = 'sending' AND email_last_attempt_at < now() - interval '5 minutes')
  )
RETURNING *
```

Only the process that gets a non-empty `RETURNING` result "owns" the send. Postgres row-level locking serialises concurrent callers; the loser sees the row in `'sending'` (not in the WHERE filter) and receives an empty result set.

**Why:** UNIQUE(event_key) prevents duplicate inserts but not duplicate retries. The atomic UPDATE closes the retry race.

## 'sending' state — stale threshold and crash recovery

A 'sending' row older than `STALE_SENDING_MS` (5 minutes) is reclaimed by the next processor run. Fresh 'sending' rows are not touched — they belong to an active in-progress attempt. Never increment `emailAttemptCount` in `finaliseEmailDelivery`; the increment happens atomically in the claim step.

## Production missing-key → false (not vacuous success)

When `RESEND_API_KEY` is absent in production, `getResendClient()` must return `{ client: null, vacuousSuccess: false }`. Returning `true` (vacuous success) would permanently silence the failure — the row would be marked 'sent' even though no email was ever sent. The distinction:

- `NODE_ENV = 'test'` + no key → `vacuousSuccess: true` (tests run cleanly)
- `NODE_ENV ≠ 'test'` + no key → `vacuousSuccess: false` (config error, row stays 'failed', retried once key is set)
