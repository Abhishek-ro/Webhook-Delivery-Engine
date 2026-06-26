#!/usr/bin/env bash
# scripts/zero-loss.sh
#
# Compares the number of k6 iterations (events posted) against the number of
# rows in the events table that were written during the test window.
#
# Usage:
#   K6_ITERATIONS=<number from k6 summary> \
#   DATABASE_URL=postgres://... \
#   CLIENT_ID=loadtest \
#   scripts/zero-loss.sh
#
# The script exits 1 if the row count doesn't match, so it can be used as a
# Makefile gate: make loadtest-baseline && make loadtest-zero-loss
#
# How K6_ITERATIONS is captured:
#   k6 run --out json=loadtest/result.json loadtest/baseline.js
#   K6_ITERATIONS=$(jq -r 'select(.metric=="iterations") | .data.value' loadtest/result.json | tail -1)

set -euo pipefail

# ---------------------------------------------------------------------------
# Inputs
# ---------------------------------------------------------------------------

ITERATIONS="${K6_ITERATIONS:-}"
DB_URL="${DATABASE_URL:-}"
CLIENT="${CLIENT_ID:-loadtest}"
# How far back to look (slightly longer than the test duration)
WINDOW="${WINDOW_MINUTES:-20}"

if [[ -z "$ITERATIONS" ]]; then
  echo "ERROR: K6_ITERATIONS env var is required." >&2
  echo "  Export it from the k6 summary 'iterations' counter." >&2
  exit 1
fi

if [[ -z "$DB_URL" ]]; then
  echo "ERROR: DATABASE_URL env var is required." >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Count events in Postgres
# ---------------------------------------------------------------------------

DB_COUNT=$(psql "$DB_URL" -t -A -c \
  "SELECT count(*) FROM events
   WHERE client_id = '$CLIENT'
     AND received_at > now() - INTERVAL '$WINDOW minutes'")

echo "k6 iterations : $ITERATIONS"
echo "DB event rows  : $DB_COUNT  (client_id='$CLIENT', last ${WINDOW}m)"

if [[ "$DB_COUNT" -eq "$ITERATIONS" ]]; then
  echo "✓ Zero-loss verified — all $ITERATIONS events persisted."
  exit 0
else
  DIFF=$(( ITERATIONS - DB_COUNT ))
  echo "✗ MISMATCH — $DIFF event(s) lost (k6=$ITERATIONS, db=$DB_COUNT)." >&2
  exit 1
fi
