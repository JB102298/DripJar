#!/bin/bash
set -e
pnpm install --frozen-lockfile
# Canonical provisioning path: `migrate` applies the recorded 0000→0023 chain and
# runs the idempotent ledger-account seeds. `push` only diffs schema structure, so
# it silently skips the seed INSERTs and leaves the chart of accounts empty.
pnpm --filter @workspace/db run migrate
