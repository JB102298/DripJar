---
name: Database schema and seed
description: Schema status and how to re-seed demo data
---

# Database Schema

## Status
Schema pushed to PostgreSQL via `pnpm --filter @workspace/db run push`.

## Tables (16 total)
users, profiles, jars, jarMembers, invitations, contributions, contributionSchedules, milestones, milestoneAllocations, commitmentRequests, commitmentVotes, agreements, agreementAcceptances, notifications, activityEvents, paymentMethodPlaceholders, refundRequestPlaceholders

## Seed Data
Run: `pnpm --filter @workspace/scripts run seed`

Creates: Jordan Barrett (jordan@tripjar.dev / password123) + Hawaii 2027 jar with:
- 5 members (Caitlyn, Mom/Mary, Dad/Robert, Brother/Tyler — all password123)
- $10,000 goal, ~$7,170 contributed (72.7%), status=Saving
- 5 milestones (Flights fully funded, others partial)
- 19 activity events, 5 notifications for Jordan

**Why:** Seed clears existing seed accounts by email before re-inserting — safe to run repeatedly.
