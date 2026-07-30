---
name: Security Sprint
description: Auth/session/CORS/rate-limiting hardening decisions and patterns applied during the security sprint.
---

## JWT tokens
- Access tokens: 15-minute expiry, include `jti` nanoid nonce so two tokens issued in the same second differ
- Refresh tokens: 32-byte crypto random, hex-encoded; only the SHA-256 hash is stored in DB (`refresh_sessions.token_hash`)
- `signToken` / `signAccessToken` are identical; `signToken` kept for backward compat

## Refresh session table
- `refresh_sessions` table added to DB via raw SQL migration (drizzle-kit push requires TTY; use psql for migrations)
- Supports token rotation with reuse detection: if a revoked token is reused, ALL sessions for that user are immediately revoked
- Password reset also revokes all sessions via DB transaction

## Reset tokens
- `users.reset_token` renamed to `users.reset_token_hash` — stores SHA-256 hash, never raw
- Raw token returned to client only when `DEV_SHOW_RESET_TOKEN=true` env var is set

## CORS
- Uses exact `Set<string>` matching on `new URL(entry).origin`; never substring/startsWith/includes
- No-origin requests (native mobile, server-to-server) are always allowed
- `ALLOWED_ORIGINS` env var is comma-separated list of allowed origins; absence = allow all (dev only)

## Rate limiting
- `express-rate-limit` with in-memory store (documented production boundary in `lib/rate-limit.ts`)
- **Disabled in `NODE_ENV=test`** so integration tests can run without hitting limits
- Rate-limit test guarded behind `TEST_RATE_LIMITS=1` env var; run with `TEST_RATE_LIMITS=1 pnpm test`

## Drizzle migrations in non-TTY
- `drizzle-kit push` fails without interactive TTY when columns are renamed (it prompts for confirmation)
- **Workaround:** run raw SQL via `psql "$DATABASE_URL"` directly

## Startup validation
- Both `src/index.ts` and `src/lib/auth.ts` validate `JWT_SECRET` at startup; index.ts fires first (imports before app.ts)
- Subprocess tests in vitest use the built `dist/index.mjs`, not tsx — tsx is not installed in api-server

## Mobile auth context
- Migrated from `AsyncStorage` to `expo-secure-store` for token storage
- Proactive token refresh: checks JWT exp before each API call; refreshes if < 60s remaining
- Mutex (Promise deduplication) prevents concurrent refresh races
- One-time migration on first launch: reads old `auth_token` from AsyncStorage → SecureStore, then removes old key
- Logout sends the refresh token in the body to revoke the specific session
