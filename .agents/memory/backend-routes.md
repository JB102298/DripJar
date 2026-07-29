---
name: API server route layout
description: All 18 route modules registered in artifacts/api-server
---

# API Server Route Layout

All routes are prefixed `/api/` (set in `app.ts`).

## Route files (`artifacts/api-server/src/routes/`)
- `health.ts` — GET /healthz
- `auth.ts` — POST /auth/register, /auth/login, /auth/logout; GET /auth/me; POST /auth/forgot-password, /auth/reset-password
- `profile.ts` — GET /profile, PATCH /profile
- `dashboard.ts` — GET /dashboard
- `jars.ts` — GET /jars, POST /jars, GET /jars/:id, PATCH /jars/:id, POST /jars/:id/launch, /jars/:id/cancel, GET /jars/:id/health
- `members.ts` — GET /jars/:id/members, PATCH /jars/:id/members/:memberId
- `invitations.ts` — POST /jars/:id/invitations; GET /invitations, /invitations/token/:token; POST /invitations/:id/accept, /invitations/:id/decline
- `contributions.ts` — GET/POST /jars/:id/contributions, POST /jars/:id/contributions/:id/reverse
- `schedules.ts` — GET/POST/PATCH /jars/:id/schedule
- `milestones.ts` — GET/POST /jars/:id/milestones, PATCH/DELETE /jars/:id/milestones/:id
- `commitments.ts` — GET/POST /jars/:id/commitments, POST /jars/:id/commitments/:id/vote
- `agreements.ts` — GET /jars/:id/agreements, POST /jars/:id/agreements/:id/accept
- `notifications.ts` — GET /notifications, PATCH /notifications/:id/read, POST /notifications/read-all
- `activity.ts` — GET /jars/:id/activity, GET /activity

## Auth middleware
`requireAuth` from `src/lib/auth.ts` — reads `Authorization: Bearer <token>`, attaches `userId` and `userEmail` to request as `AuthenticatedRequest`.
