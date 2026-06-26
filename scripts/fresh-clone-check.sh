#!/usr/bin/env bash
# scripts/fresh-clone-check.sh
#
# Verifies that the project works end-to-end from a clean checkout.
# Intended as a CI gate and a "does this repo actually work?" sanity check
# before recording a demo or handing off to a reviewer.
#
# What it does:
#   1. Boots the Docker stack (make up)
#   2. Applies migrations (make migrate)
#   3. Registers a webhook endpoint pointing at the test-receiver /ok route
#   4. Sends an event via POST /v1/events
#   5. Polls GET /v1/deliveries/:id until status = DELIVERED (or times out)
#   6. Prints the full transition chain
#   7. Tears down the stack
#   8. Exits 0 on success, 1 on any failure
#
# Usage:
#   bash scripts/fresh-clone-check.sh
#
# Prerequisites:
#   Docker, make, curl, jq — nothing else.
#
# Environment overrides:
#   API_URL          — default http://localhost:3000
#   POLL_TIMEOUT_S   — seconds to wait for DELIVERED (default 60)
#   POLL_INTERVAL_S  — seconds between polls (default 3)
#   SKIP_TEARDOWN    — set to 1 to leave the stack running after the check

set -euo pipefail

API_URL="${API_URL:-http://localhost:3000}"
POLL_TIMEOUT_S="${POLL_TIMEOUT_S:-60}"
POLL_INTERVAL_S="${POLL_INTERVAL_S:-3}"
SKIP_TEARDOWN="${SKIP_TEARDOWN:-0}"

RED='\033[0;31m'
GRN='\033[0;32m'
YLW='\033[1;33m'
NC='\033[0m'

pass() { echo -e "${GRN}✓${NC} $*"; }
fail() { echo -e "${RED}✗${NC} $*" >&2; exit 1; }
info() { echo -e "${YLW}→${NC} $*"; }

# ---------------------------------------------------------------------------
# Teardown trap
# ---------------------------------------------------------------------------

teardown() {
  if [[ "$SKIP_TEARDOWN" != "1" ]]; then
    info "Tearing down stack..."
    make down >/dev/null 2>&1 || true
  fi
}
trap teardown EXIT

# ---------------------------------------------------------------------------
# 1. Boot stack
# ---------------------------------------------------------------------------

info "Booting Docker stack..."
make up >/dev/null 2>&1 || fail "make up failed"
pass "Stack started"

info "Waiting for API to be ready..."
READY=0
for i in $(seq 1 20); do
  if curl -sf "${API_URL}/healthz" >/dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 2
done
[[ "$READY" -eq 1 ]] || fail "API did not become healthy within 40s"
pass "API healthy"

# ---------------------------------------------------------------------------
# 2. Migrate
# ---------------------------------------------------------------------------

info "Running migrations..."
make migrate >/dev/null 2>&1 || fail "make migrate failed"
pass "Migrations applied"

# ---------------------------------------------------------------------------
# 3. Register endpoint
# ---------------------------------------------------------------------------

info "Registering endpoint..."
EP_RESP=$(curl -sf -X POST "${API_URL}/v1/endpoints" \
  -H 'Content-Type: application/json' \
  -d '{"client_id":"fresh-clone-check","url":"http://test-receiver:4000/ok","signing_secret":"whsec_fresh_clone_secret"}') \
  || fail "POST /v1/endpoints failed"

ENDPOINT_ID=$(echo "$EP_RESP" | jq -r '.id')
[[ -n "$ENDPOINT_ID" && "$ENDPOINT_ID" != "null" ]] || fail "No endpoint ID in response: $EP_RESP"
pass "Endpoint registered: $ENDPOINT_ID"

# ---------------------------------------------------------------------------
# 4. Send event
# ---------------------------------------------------------------------------

info "Sending event..."
EV_RESP=$(curl -sf -X POST "${API_URL}/v1/events" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: fresh-clone-check-001' \
  -d "{\"client_id\":\"fresh-clone-check\",\"event_type\":\"fresh.clone.check\",\"payload\":{\"ts\":$(date +%s)},\"endpoint_id\":\"${ENDPOINT_ID}\"}") \
  || fail "POST /v1/events failed"

DELIVERY_ID=$(echo "$EV_RESP" | jq -r '.delivery_id // .id')
[[ -n "$DELIVERY_ID" && "$DELIVERY_ID" != "null" ]] || fail "No delivery_id in response: $EV_RESP"
pass "Event accepted — delivery_id: $DELIVERY_ID"

# ---------------------------------------------------------------------------
# 5. Poll until DELIVERED
# ---------------------------------------------------------------------------

info "Polling for DELIVERED status (timeout: ${POLL_TIMEOUT_S}s)..."
ELAPSED=0
FINAL_STATUS=""
while [[ $ELAPSED -lt $POLL_TIMEOUT_S ]]; do
  DETAIL=$(curl -sf "${API_URL}/v1/deliveries/${DELIVERY_ID}") || { sleep "$POLL_INTERVAL_S"; ELAPSED=$(( ELAPSED + POLL_INTERVAL_S )); continue; }
  FINAL_STATUS=$(echo "$DETAIL" | jq -r '.status')

  if [[ "$FINAL_STATUS" == "DELIVERED" ]]; then
    pass "Delivery reached DELIVERED in ~${ELAPSED}s"
    break
  fi

  if [[ "$FINAL_STATUS" == "DLQ" || "$FINAL_STATUS" == "FAILED" ]]; then
    echo "$DETAIL" | jq '.attempts[-1]' >&2
    fail "Delivery ended in $FINAL_STATUS after ${ELAPSED}s — see attempts above"
  fi

  echo "  status=$FINAL_STATUS (${ELAPSED}s elapsed)..."
  sleep "$POLL_INTERVAL_S"
  ELAPSED=$(( ELAPSED + POLL_INTERVAL_S ))
done

[[ "$FINAL_STATUS" == "DELIVERED" ]] || fail "Timed out after ${POLL_TIMEOUT_S}s — final status: $FINAL_STATUS"

# ---------------------------------------------------------------------------
# 6. Print transition chain
# ---------------------------------------------------------------------------

echo ""
echo "=== Transition chain ==="
curl -sf "${API_URL}/v1/deliveries/${DELIVERY_ID}" | \
  jq -r '.transitions[] | "\(.from_status // "—") → \(.to_status)  [\(.actor)]  \(.created_at)"'
echo ""

# ---------------------------------------------------------------------------
# 7. Done
# ---------------------------------------------------------------------------

pass "Fresh-clone check passed."
