#!/bin/bash
# Fresh migration verification: creates a clean DB, applies 0000-0017, verifies schema.
set -euo pipefail

PSQL_OPTS="-h helium -U postgres -w --no-password"
ADMIN_DB="heliumdb"
DB_NAME="m3jar_migration_verify_$(date +%s)"
DRIZZLE_DIR="/home/runner/workspace/lib/db/drizzle"

PASS=0
FAIL=0
pass() { echo "  ✓  $1"; PASS=$((PASS+1)); }
fail() { echo "  ✗  $1  ${2:-}"; FAIL=$((FAIL+1)); }

# ── STEP 1: Create fresh database ─────────────────────────────────────────────
echo ""
echo "=== STEP 1: Create fresh database: $DB_NAME ==="
psql $PSQL_OPTS -d "$ADMIN_DB" -c "CREATE DATABASE \"$DB_NAME\";" && pass "Created $DB_NAME"

# ── STEP 2: Apply migrations 0000 → 0017 ──────────────────────────────────────
echo ""
echo "=== STEP 2: Apply migrations 0000 → 0017 ==="
FILES=$(ls "$DRIZZLE_DIR"/[0-9][0-9][0-9][0-9]_*.sql | sort)
COUNT=$(echo "$FILES" | wc -l | tr -d ' ')
echo "Found $COUNT migration files"
if [ "$COUNT" -ne 18 ]; then fail "Expected 18 files, found $COUNT"; fi

for f in $FILES; do
  FNAME=$(basename "$f")
  OUTPUT=$(psql $PSQL_OPTS -d "$DB_NAME" -f "$f" 2>&1)
  STATUS=$?
  if [ $STATUS -eq 0 ]; then
    pass "Applied $FNAME"
  else
    fail "Applied $FNAME" "$(echo "$OUTPUT" | tail -2)"
    echo "    Error: $OUTPUT" | head -5
  fi
done

# ── STEP 3: Verify schema ──────────────────────────────────────────────────────
echo ""
echo "=== STEP 3: Verify schema ==="

# 3a. Phase 4C tables
for TABLE in commitment_snapshots commitment_snapshot_allocations fund_commitments commitment_allocations refund_requests refund_allocations; do
  COUNT=$(psql $PSQL_OPTS -d "$DB_NAME" -tAc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name='$TABLE';")
  if [ "$COUNT" = "1" ]; then pass "Table exists: $TABLE"; else fail "Table missing: $TABLE"; fi
done

# 3b. REFUND_PENDING in ledger_accounts
COUNT=$(psql $PSQL_OPTS -d "$DB_NAME" -tAc "SELECT count(*) FROM ledger_accounts WHERE account_type='REFUND_PENDING';")
if [ "$COUNT" = "1" ]; then pass "ledger_accounts includes REFUND_PENDING"; else fail "ledger_accounts missing REFUND_PENDING (count=$COUNT)"; fi

# 3c. Placeholder table dropped
COUNT=$(psql $PSQL_OPTS -d "$DB_NAME" -tAc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name='refund_request_placeholders';")
if [ "$COUNT" = "0" ]; then pass "refund_request_placeholders correctly dropped by migration 0015"; else fail "refund_request_placeholders still exists"; fi

# 3d. ft_transaction_type_check includes Phase 4C types
CHECK_DEF=$(psql $PSQL_OPTS -d "$DB_NAME" -tAc "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='ft_transaction_type_check';" 2>/dev/null || echo "")
for TYPE in refund_reservation refund_finalization refund_reversal commitment_transfer; do
  if echo "$CHECK_DEF" | grep -q "$TYPE"; then
    pass "ft_transaction_type_check includes '$TYPE'"
  else
    fail "ft_transaction_type_check missing '$TYPE'" "$CHECK_DEF"
  fi
done

# 3e. Key Phase 4C indexes
for IDX in commitment_snapshots_status_expires_idx fund_commitments_snapshot_idx refund_allocations_dispatch_idx refund_allocations_stripe_refund_unique_idx refund_requests_member_jar_idx; do
  COUNT=$(psql $PSQL_OPTS -d "$DB_NAME" -tAc "SELECT count(*) FROM pg_indexes WHERE schemaname='public' AND indexname='$IDX';")
  if [ "$COUNT" = "1" ]; then pass "Index exists: $IDX"; else fail "Index missing: $IDX"; fi
done

# 3f. fund_commitments NOT NULL columns
for COL in agreement_id agreement_version snapshot_id jar_id member_id; do
  NULLABLE=$(psql $PSQL_OPTS -d "$DB_NAME" -tAc "SELECT is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name='fund_commitments' AND column_name='$COL';" | tr -d ' ')
  if [ "$NULLABLE" = "NO" ]; then
    pass "fund_commitments.$COL is NOT NULL"
  else
    fail "fund_commitments.$COL nullable=$NULLABLE (expected NOT NULL)"
  fi
done

# 3g. Total table count
TABLE_COUNT=$(psql $PSQL_OPTS -d "$DB_NAME" -tAc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE';")
TABLE_COUNT=$(echo "$TABLE_COUNT" | tr -d ' ')
if [ "$TABLE_COUNT" -ge 16 ]; then
  pass "Schema table count: $TABLE_COUNT (>= 16)"
else
  fail "Schema table count: $TABLE_COUNT (expected >= 16)"
fi

# 3h. commitment_snapshots key columns
SNAP_COLS=$(psql $PSQL_OPTS -d "$DB_NAME" -tAc "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='commitment_snapshots' AND column_name IN ('id','jar_id','member_id','snapshot_token','status','expires_at','confirmed_at') ORDER BY column_name;" | tr -d ' ' | tr '\n' ',')
EXPECTED="confirmed_at,expires_at,id,jar_id,member_id,snapshot_token,status,"
if [ "$SNAP_COLS" = "$EXPECTED" ]; then
  pass "commitment_snapshots columns correct: $SNAP_COLS"
else
  fail "commitment_snapshots columns: got=$SNAP_COLS expected=$EXPECTED"
fi

# 3i. refund_requests and refund_allocations have status columns
for TABLE in refund_requests refund_allocations; do
  COL=$([ "$TABLE" = "refund_requests" ] && echo "status" || echo "provider_status")
  COUNT=$(psql $PSQL_OPTS -d "$DB_NAME" -tAc "SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='$TABLE' AND column_name='$COL';")
  if [ "$COUNT" = "1" ]; then pass "$TABLE.$COL column exists"; else fail "$TABLE.$COL column missing"; fi
done

# ── STEP 4: Drop test database ────────────────────────────────────────────────
echo ""
echo "=== STEP 4: Drop test database ==="
psql $PSQL_OPTS -d "$ADMIN_DB" -c "DROP DATABASE \"$DB_NAME\";" && pass "Dropped $DB_NAME"

# Also clean up the unused test DB created earlier if it exists
EXTRA_DBS=$(psql $PSQL_OPTS -d "$ADMIN_DB" -tAc "SELECT datname FROM pg_database WHERE datname LIKE 'm3jar_migration_test_%';" 2>/dev/null || echo "")
for EXTRA in $EXTRA_DBS; do
  EXTRA=$(echo "$EXTRA" | tr -d ' ')
  if [ -n "$EXTRA" ]; then
    psql $PSQL_OPTS -d "$ADMIN_DB" -c "DROP DATABASE \"$EXTRA\";" 2>/dev/null && echo "  Cleaned up $EXTRA" || true
  fi
done

# ── SUMMARY ───────────────────────────────────────────────────────────────────
echo ""
echo "=== SUMMARY ==="
echo "$PASS checks passed, $FAIL failed"
if [ "$FAIL" -gt 0 ]; then
  exit 1
else
  echo "ALL FRESH MIGRATION CHECKS PASSED"
  exit 0
fi
