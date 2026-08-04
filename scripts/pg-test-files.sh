#!/usr/bin/env bash
# Lists test files that actually need a live Postgres connection: they either
# read process.env.PG_CONNECTION_STRING directly, or go through the
# describe-each-dialect harness (packages/store-postgres/test/describe-each-dialect.ts),
# which does. Verified equivalent to a full import-graph walk as of 2026-08-04.
#
# `test:pg` filters `vitest run` down to this list so the integration job
# doesn't re-run the ~150 sqlite/fake-only files the unit job already covered.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
grep -rlE 'process\.env\.PG_CONNECTION_STRING|describe-each-dialect' \
	packages/*/test sites/*/test --include='*.test.ts'
