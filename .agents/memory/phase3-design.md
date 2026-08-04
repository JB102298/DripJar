---
name: Phase 3 design decisions
description: Key correctness and security decisions made during Phase 3 conformance corrections — cumulative accounting, UTC dates, delivery state, cutoff immutability, timing-safe token.
---

## Cumulative contribution obligation accounting

**Rule:** `outstandingCents = max(0, countElapsedPeriods(schedule, now) × amountCents − totalContributedCents)`

**Why:** The old ±1-day window approach double-counted contributions and broke for partial payments, overpayments, and multi-period arrears. The cumulative approach is deterministic and correct for all cases.

**How to apply:** Callers of `computeScheduleStatus()` must fetch and sum ALL member contributions since `schedule.startDate` with status `completed` or `simulated`, then pass the total as `totalContributedCents`. The start date itself is a due date; `countElapsedPeriods` returns 0 when today IS the start date, 1 after the first period closes.

## UTC-only date math

**Rule:** All schedule date arithmetic uses UTC equivalents (`Date.UTC()`, `.getUTCFullYear()`, `.toISOString().slice(0,10)`). Never use local getters (`getDate()`, `getMonth()`) in server-side schedule logic.

**Why:** Server TZ may differ from UTC (host machine or Replit environment). A UTC date boundary at `2026-01-01T00:00:00Z` would appear as Dec 31 in UTC-5 if local getters were used.

**How to apply:** `schedule-utils.ts` has `parseUTCDate()`, `stripTime()`, `toISODate()` — all UTC-safe. `safeUTCMonthDate()` prevents day-rollover (e.g. Feb 31 → Feb 28). Import from `schedule-utils.ts` only; never compute dates inline.

## Email delivery state on reminder_sent_events

**Rule:** `emailStatus` transitions: `pending → sent | failed | skipped_preference`. Failed rows are retried next run. Sent/skipped_preference rows are permanently skipped.

**Why:** The original `claimReminderEvent` inserted the row BEFORE sending email — if send failed, the row existed as "sent" and the failure was silently swallowed forever.

**How to apply:** `claimOrFetchEvent()` returns `{ isNew, row }`. If `!isNew && row.emailStatus ∈ {sent, skipped_preference}` → skip. New rows: create notification, attempt email, update delivery state. Failed rows: re-attempt email only (no new notification).

## Cutoff immutability after agreement acceptance

**Rule:** `PATCH /jars/:id` with a changed `cutoffDate` returns `400` if any member has accepted the current agreement version.

**Why:** Accepting an agreement implicitly accepts the stated cutoffDate as a term. Silently shifting the date would retroactively change accepted terms. To change, organizer must publish a new agreement version.

**How to apply:** The check is in `routes/jars.ts` inside the cutoff validation block — runs only when `cutoffDate` is changing AND a previous cutoffDate exists.

## Timing-safe internal token comparison

**Rule:** `requireInternalToken` uses `crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(configured))` with an explicit length-equality guard before the comparison.

**Why:** String `===` comparison exits early on the first differing byte, leaking token length/prefix via timing side-channel.

**How to apply:** Always compare same-length buffers. When lengths differ, compare the provided token against a same-length dummy buffer (ensures constant time), then AND the result with `lengthsMatch` to produce a correct false negative.

## `countElapsedPeriods` semantics

The start date itself is a due date. A period is "elapsed" when `dueDate < today` (strictly less than). So:
- `today === startDate` → 0 elapsed
- `today === startDate + 1 day` → 1 elapsed (startDate has passed)

Tests must account for this: "6 days into a weekly schedule" → 1 period elapsed (start date passed).
