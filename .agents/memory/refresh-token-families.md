---
name: Refresh token families
description: Durable decisions for TripJar refresh-token rotation, families, and concurrency verification
---

# Refresh token families — durable decisions

- **Policy:** each device session belongs to a token family (uuid). New family on login/register; inherited on rotation. Replay detection revokes only the family, never all user sessions.
- **Strict one-time rotation, no grace window.** A lost refresh response forces re-login on that device only. **Why:** accepted UX cost for stronger replay guarantees.
- **Atomic rotation:** whole refresh flow in one transaction with `SELECT … FOR UPDATE`; failure paths return sentinel values (not throws) so revocations still commit on 401 paths.
- **Controlled revoke reasons** (exact spellings matter, spec-mandated): `rotated`, `token_reuse_detected`, `logout`, `logout_all`, `password_reset`, `expired`.
- **401 responses are generic** — never reveal replay detection.
- **Lesson:** drizzle `.defaultRandom()` in schema.ts does NOT put a DEFAULT in a hand-authored migration — verify `column_default` with a direct information_schema query, not drizzle-kit output. A follow-up migration adding `SET DEFAULT gen_random_uuid()` fixed this mismatch.
- **Lesson:** concurrency proofs need separate PG backends — a transaction pins a pool connection; prove with `pg_backend_pid()` per connection and poll `pg_locks` (granted=false) rather than fixed sleeps.
- **Mobile client:** proactive refresh with in-flight promise mutex, zero automatic retries; terminal refresh failure wipes both SecureStore token keys. Mobile unit tests run under vitest+jsdom with SecureStore/fetch mocked (no emulator needed).
