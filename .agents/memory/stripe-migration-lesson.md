---
name: Stripe migration — direct SQL required
description: drizzle-kit migrate reports success but does not track or apply migrations; hand-written SQL must be run directly against the DB. Also: ft_provider_status_check constraint must be expanded for new statuses.
---

# Stripe Phase 4B — migration and constraint lessons

## The rule
`drizzle-kit migrate` always exits 0 and reports "migrations applied successfully!" even when it has no migration tracking table and has done nothing. Hand-written SQL migrations (0010, 0011) must be applied by running raw SQL against the DB directly.

**Why:** The project's drizzle.config.ts has no `migrations` tracking config, so drizzle-kit has no state. It silently no-ops. The only way to apply schema changes is via direct `pg` client or `psql`.

**How to apply:**
```javascript
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const client = await pool.connect();
await client.query(/* SQL from migration file */);
```

## The `ft_provider_status_check` constraint
When adding new `provider_status` values to `financial_transactions`, the existing CHECK constraint must be dropped and recreated:
```sql
ALTER TABLE financial_transactions DROP CONSTRAINT ft_provider_status_check;
ALTER TABLE financial_transactions ADD CONSTRAINT ft_provider_status_check
  CHECK (provider_status = ANY (ARRAY['not_applicable','pending','succeeded','failed','quoted','provider_created','processing','cancelled']));
```

Phase 4B values added: `'quoted'`, `'provider_created'`, `'processing'`, `'cancelled'`.

## The mock PI ID uniqueness lesson
In Stripe tests, if the mock always returns the same PaymentIntent ID (e.g. `"pi_test_mock123"`), multiple tests in the same describe block will create multiple financial_transactions with the same `providerTransactionId`. The webhook handler's `eq(financialTransactions.providerTransactionId, pi.id)` will match the wrong (older) row, causing silent test failures where `providerStatus` stays `provider_created`.

Fix: use a counter in the mock so each `paymentIntents.create` call returns a unique ID:
```typescript
let _piCounter = 0;
create: vi.fn().mockImplementation(async () => {
  const id = `pi_test_mock_${++_piCounter}_${Date.now()}`;
  return { id, ... };
})
```
