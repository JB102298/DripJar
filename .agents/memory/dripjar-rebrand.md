---
name: DripJar rebrand
description: Decisions and whitelists from the M3Jar → DripJar rebrand; what was changed and why specific things were left alone.
---

# DripJar Rebrand — Key Decisions

## What was changed
- All customer-facing strings: email templates, subjects, sender fallback (`thedripjar.com`), base-URL fallback
- Route copy: DEFAULT_AGREEMENT_TEXT, inviter name fallback
- Mobile screens: welcome, login, register, reset-password
- API spec and generated client comments
- README.md, replit.md, seed emails (@m3jar.dev → @dripjar.dev), PDF scripts
- app.json: name → DripJar, slug → dripjar, scheme → dripjar (bundleIdentifier left — see below)

## What was intentionally left unchanged

### AsyncStorage keys — LEAVE
`tripjar_access_token` / `tripjar_refresh_token` in `contexts/auth-context.tsx`.
**Why:** Internal only, not customer-visible. Changing them would silently log out all users.

### bundleIdentifier / android.package — OWNER ACTION REQUIRED
Still reads `com.m3jar.app` in `artifacts/mobile/app.json`.
**Why:** Must be changed to `com.dripjar.app` **before** any App Store / Play Store submission. Safe to change now but left as documented owner action per spec guidance.

### Migration test DB names — LEAVE
`m3jar_migration_verify_*` in run-fresh-migration scripts.
**Why:** Internal dev identifiers, never customer-visible.

### lib/db/drizzle/*.sql — LEAVE
Historical migration files, immutable by design. Confirmed clean (no brand strings).

## Brand guard
`artifacts/api-server/src/__tests__/brand-guard.test.ts` scans 148 source files across 7 dirs.
Checks: `M3Jar`, `TripJar` (exact), `m3jar.com`, `@m3jar.dev`, `updates.m3jar.com` (CI).
Whitelisted: brand-guard.test.ts itself, drizzle/ dir, auth-context files, run-fresh-migration scripts.

## Owner actions still needed
1. Resend: add `updates.thedripjar.com` sending domain + verify DNS + update `EMAIL_FROM`
2. GitHub: rename repo JB102298/TripJar → JB102298/DripJar
3. `APP_BASE_URL` → `https://TheDripJar.com` in production secrets
4. `ALLOWED_ORIGINS` → add thedripjar.com origins
5. Stripe Dashboard: update public branding
6. Replit display name: manual UI action

## Commit
"Rebrand M3Jar to DripJar" — 22 files changed, 1 new file (brand-guard.test.ts)
