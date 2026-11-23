#!/usr/bin/env bash
# Lists test files that actually need a live Postgres connection: they either
# read process.env.PG_CONNECTION_STRING directly, or go through the
# describe-each-dialect harness (`store-emdash`'s own
# test/describe-each-dialect.ts — @otta-sh/store-postgres, which had its own
# copy, is gone), which does. Verified equivalent to a full import-graph walk
# as of 2026-08-04.
#
# `test:pg` filters `vitest run` down to this list so the integration job
# doesn't re-run the ~150 sqlite/fake-only files the unit job already covered.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
grep -rlE 'process\.env\.PG_CONNECTION_STRING|describe-each-dialect' \
	packages/*/test sites/*/test --include='*.test.ts'
# packages/core (Otta Core) has its own harness: test/harness.ts picks EmDash's
# Postgres dialect when PG_CONNECTION_STRING is set, and test/fixtures.ts builds
# on it, so every core test file that imports either one runs against Postgres.
grep -lE 'from "\./(harness|fixtures)\.js"' packages/core/test/*.test.ts
