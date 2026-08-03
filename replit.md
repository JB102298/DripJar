# M3Jar

Making Meaningful Moments Happen. A mobile-first collaborative group savings app for shared travel — family vacations, cruises, honeymoons, and group trips. Members contribute toward a shared jar, track progress against milestones, and coordinate through in-app notifications and schedules.

## Run & Operate

| Command | Description |
|---|---|
| `pnpm --filter @workspace/api-server run dev` | Build + start API server (uses `PORT` env var) |
| `pnpm --filter @workspace/mobile run dev` | Start Expo mobile app |
| `pnpm run typecheck` | Full typecheck across all packages |
| `pnpm --filter @workspace/db run push` | Push DB schema changes (dev only — requires TTY) |
| `pnpm --filter @workspace/scripts run seed` | Seed dev DB (user: `jordan@m3jar.dev` / `password123`) |
| `pnpm --filter @workspace/api-server run test` | Run security + unit test suite (`NODE_ENV=test`) |
| `pnpm --filter @workspace/scripts run generate-pdf` | Regenerate `M3Jar-Codebase.pdf` (see below) |

## Required Environment Variables

| Variable | Where set | Purpose |
|---|---|---|
| `DATABASE_URL` | Replit Database (auto-provisioned) | PostgreSQL connection string |
| `JWT_SECRET` | Replit Secret | Signs JWT access tokens — must be ≥ 32 chars |
| `SESSION_SECRET` | Replit Secret | Express session signing |
| `PORT` | Replit (auto-set) | Server listen port |

**Optional (dev)**
| Variable | Default | Purpose |
|---|---|---|
| `DEV_SHOW_RESET_TOKEN` | `false` | When `true`, forgot-password response includes the raw reset token for local testing |
| `ALLOWED_ORIGINS` | `(allow all)` | Comma-separated exact origins for CORS; **required in production** |

## Regenerating the Codebase Report

The `M3Jar-Codebase.pdf` file is a formatted source listing used for code review and archival.

```bash
pnpm --filter @workspace/scripts run generate-pdf
```

The generator (`scripts/src/generate-codebase-pdf.ts`):
- Uses an **allow-list** of source directories — nothing outside them is ever read
- Applies a **path deny-list** blocking `.env`, `node_modules`, `dist`, `.git`, `*.pem`, `*.key`, etc.
- **Content-scans** every file before inclusion for patterns matching real secrets (postgres:// connection strings with credentials, PEM private keys, long JWT token values, AWS-style access keys)
- Embeds the current **git commit hash** and generation timestamp on the cover page
- Appends a "Skipped Files" list if any file was excluded by the content scanner
- Prints a summary of included/skipped files to stdout

The download endpoint (`GET /api/download/codebase`) always serves the most recently generated file with `Cache-Control: no-store`. Path is locked at startup; no user-supplied path parameters are accepted.

## Stack

- **Runtime**: Node.js 24, TypeScript 5.9, pnpm workspaces
- **API**: Express 5, Drizzle ORM, PostgreSQL
- **Mobile**: Expo / React Native (Expo Router)
- **Auth**: JWT Bearer tokens (15 min access + 30-day refresh rotation), `expo-secure-store`
- **Validation**: Zod (v3) on all auth routes
- **Security**: Helmet, express-rate-limit, exact CORS origin matching, hashed reset tokens
- **Tests**: Vitest + Supertest (67 security tests)

## Where Things Live

| Area | Path |
|---|---|
| DB schema (16 tables) | `lib/db/src/schema/index.ts` |
| Auth middleware + token helpers | `artifacts/api-server/src/lib/auth.ts` |
| Zod validation schemas | `artifacts/api-server/src/lib/validation.ts` |
| Rate limiters | `artifacts/api-server/src/lib/rate-limit.ts` |
| All API routes | `artifacts/api-server/src/routes/` |
| Mobile screens | `artifacts/mobile/app/` |
| Mobile auth context (SecureStore) | `artifacts/mobile/contexts/auth-context.tsx` |
| Security test suite | `artifacts/api-server/src/__tests__/auth-security.test.ts` |
| Codebase PDF generator | `scripts/src/generate-codebase-pdf.ts` |

## Architecture Decisions

- **JWT Bearer tokens** (not cookies) — cleaner for React Native; no CSRF surface
- **Integer cents everywhere** — no floats in contribution amounts to avoid rounding errors
- **Simulated payments only** — Stripe integration path documented but not wired for MVP
- **Refresh token rotation with reuse detection** — if a revoked token is presented, all sessions are immediately invalidated
- **Rate limiters disabled in `NODE_ENV=test`** — prevents false 429s in integration tests; real-limit behaviour tested with `TEST_RATE_LIMITS=1`
- **Drizzle push requires TTY** — column renames prompt interactively; use `psql "$DATABASE_URL"` for raw SQL migrations in CI/non-TTY shells

## Gotchas

- `@react-native-community/datetimepicker@9.1.0` is installed but Expo expects `8.4.4` — app works but Metro warns; downgrade separately
- `orval` 8.x generates Zod v4 syntax; workspace uses Zod v3 — `lib/api-zod` is intentionally empty/disabled
- Calendar dates use local ISO format (`YYYY-MM-DD`) via `toLocalISO` helper — never `.toISOString()` which UTC-shifts in US timezones
- `ALLOWED_ORIGINS` must be set before deploying to production or CORS accepts all origins
