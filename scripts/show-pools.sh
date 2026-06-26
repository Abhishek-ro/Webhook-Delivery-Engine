#!/usr/bin/env bash
# scripts/show-pools.sh
#
# Watch pgBouncer pool utilisation every 5 seconds during a load test.
# Prints SHOW POOLS; output in a scrolling loop so you can watch
# cl_active / sv_active / sv_idle change in real time.
#
# Usage (while load test is running in another terminal):
#   PGBOUNCER_URL=postgres://webhooks:webhooks@localhost:5432/pgbouncer \
#   scripts/show-pools.sh
#
# Or via Makefile:
#   make loadtest-pools
#
# Ctrl-C to stop.
#
# Reading the output:
#   cl_active  — clients currently executing a query
#   cl_waiting — clients waiting for a server connection (pool exhausted)
#   sv_active  — server connections in use
#   sv_idle    — server connections idle and available
#   sv_used    — connections returned to pool but not yet reset
#   sv_tested  — connections being tested/reset
#   maxwait    — seconds the longest-waiting client has been waiting
#
# A rising cl_waiting or maxwait > 0 signals pool exhaustion.
# If sv_active ≈ DEFAULT_POOL_SIZE the pool is at capacity.

set -euo pipefail

PGBOUNCER_URL="${PGBOUNCER_URL:-postgres://webhooks:webhooks@localhost:5432/pgbouncer}"
INTERVAL="${POLL_INTERVAL_SECONDS:-5}"

echo "Watching pgBouncer pools every ${INTERVAL}s — Ctrl-C to stop"
echo "URL: ${PGBOUNCER_URL}"
echo ""

while true; do
  echo "$(date '+%H:%M:%S') ─────────────────────────────────────────────"
  psql "$PGBOUNCER_URL" -c "SHOW POOLS;" 2>&1 || echo "(connection failed — is the stack running?)"
  echo ""
  sleep "$INTERVAL"
done
