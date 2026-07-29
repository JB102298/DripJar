---
name: TripJar architecture decisions
description: Core architectural choices for TripJar — auth, money, payments
---

# TripJar Core Architecture

## Auth
- JWT Bearer token (not session cookies) — cleaner for React Native
- Secret in env var `JWT_SECRET`; fallback dev value exists but prod must set it
- Tokens expire in 30 days
- `requireAuth` middleware in `artifacts/api-server/src/lib/auth.ts`
- Mobile: token stored in AsyncStorage, loaded in `AuthContext` (`contexts/auth-context.tsx`)
- `setBaseUrl` and `setAuthTokenGetter` from `@workspace/api-client-react` must be called on app start

## Money
- All amounts stored as integer cents (e.g. $10.00 = 1000)
- `goalAmountCents`, `amountCents`, `contributionTargetCents` — all cents
- Never store floats for money

## Payments
- MVP uses "simulated" contributions only (`status: 'simulated'` in contributions table)
- No real financial data flows through the app
- `paymentMethodPlaceholders` and `refundRequestPlaceholders` tables exist for future use

**Why:** Professional financial/legal review required before real custody of funds.

## Jar Health
- Calculated on the fly in `src/lib/jar-health.ts`
- Thresholds: Ahead (>+10%), OnTrack (-10% to +10%), NeedsAttention (-20% to -10%), AtRisk (<-20%)
- Based on time-proportional expected progress vs actual
