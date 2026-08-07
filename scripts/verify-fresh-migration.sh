#!/bin/bash
# Fresh-database migration verification.
#
# Thin wrapper around scripts/run-fresh-migration.mjs, which is the single source
# of truth for what a fresh provision must produce (chain 0000→0023, 33 tables,
# 8 seeded ledger accounts, no duplicates, idempotent re-run).
#
# Requires DATABASE_URL pointing at a server where the role may CREATE DATABASE.
set -euo pipefail

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL not set — cannot run fresh-migration verification." >&2
  exit 1
fi

exec node "$(dirname "$0")/run-fresh-migration.mjs"
