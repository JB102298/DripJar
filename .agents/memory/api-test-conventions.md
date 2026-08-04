---
name: API/mobile test conventions
description: Gotchas when writing supertest/vitest suites in this monorepo
---
- All api-server routes are mounted under `/api` — supertest paths must include the prefix (`/api/auth/register`), or everything 404s.
- Register/login responses use `token` (not `accessToken`) plus `refreshToken`, `user`, `profile`.
- The email module returns a null Resend client when `NODE_ENV === "test"`, so suites can register throwaway accounts without real delivery. Tests that flip `NODE_ENV=production` must also clear `RESEND_API_KEY`.
- Mobile screens loading static images via `require('...jpg')` crash under vitest (Metro-only). In screen tests, feed mock data that avoids the asset fallback branch (e.g. a `coverImageUrl`).
- **Why:** each of these cost a debugging round in the Phase 2 lifecycle work.
- **How to apply:** any new supertest or react-native-web screen test.
