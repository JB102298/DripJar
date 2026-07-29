---
name: Zod codegen disabled
description: Why api-zod generation is disabled and what to do about it
---

# Zod Codegen Disabled

## The Problem
orval 8.x generates zod v4 syntax (`z.int()`, `z.iso`, `z.looseObject()`) but the workspace has **zod v3.25.76**. Enabling the zod output block in `lib/api-spec/orval.config.ts` causes TypeScript/runtime errors.

## What Was Done
- Removed `lib/api-zod` from root `tsconfig.json` references
- Cleared `lib/api-zod/src/generated/api.ts` to empty
- Disabled the zod output block in `lib/api-spec/orval.config.ts`
- `health.ts` route no longer imports from `@workspace/api-zod` (would fail)

**Why:** Keeping `api-zod` generating broken code silently fails in prod.

## To Fix Later
Either upgrade to zod v4 (requires updating all zod imports in the codebase) or pin orval to a version that targets zod v3. Do not simply re-enable the output block without resolving this.
