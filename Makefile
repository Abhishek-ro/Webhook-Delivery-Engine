# Use sh (Git Bash on Windows, /bin/sh on Linux/Mac) so Unix shell syntax works
SHELL := sh

.PHONY: up up-no-build down migrate test lint typecheck demo chaos chaos-no-build chaos-loop \
        loadtest-up loadtest-down loadtest-baseline loadtest-lag loadtest-zero-loss \
        loadtest-abuse loadtest-backpressure loadtest-saturation loadtest-expectation loadtest-pools

up:
	docker compose up --build -d

up-no-build:
	docker compose up -d

down:
	docker compose down -v

migrate:
	docker compose exec api sh -c "DATABASE_URL=postgres://webhooks:webhooks@pgbouncer:5432/webhooks pnpm node-pg-migrate up -m migrations"

test:
	pnpm vitest run

lint:
	pnpm eslint src test

typecheck:
	pnpm tsc --noEmit

demo:
	$(MAKE) up
	@echo "Waiting for services to be healthy..."
	@for i in $$(seq 1 20); do \
	  curl -sf http://localhost:3000/healthz >/dev/null 2>&1 && break; \
	  sleep 2; \
	done
	$(MAKE) migrate
	@echo ""
	@echo "=== Registering endpoint ==="
	$(eval EP_ID := $(shell curl -sf -X POST http://localhost:3000/v1/endpoints \
	  -H 'Content-Type: application/json' \
	  -d '{"client_id":"demo","url":"http://test-receiver:4000/ok","signing_secret":"whsec_test_receiver_secret"}' \
	  | jq -r '.id'))
	@echo "Endpoint: $(EP_ID)"
	@echo ""
	@echo "=== Posting event ==="
	$(eval DL_ID := $(shell curl -sf -X POST http://localhost:3000/v1/events \
	  -H 'Content-Type: application/json' \
	  -H 'Idempotency-Key: demo-$(shell date +%s)' \
	  -d '{"client_id":"demo","event_type":"payment.completed","payload":{"amount":100},"endpoint_id":"$(EP_ID)"}' \
	  | jq -r '.delivery_id // .id'))
	@echo "Delivery: $(DL_ID)"
	@echo ""
	@echo "=== Polling for DELIVERED (up to 30s) ==="
	@STATUS=""; \
	for i in $$(seq 1 15); do \
	  STATUS=$$(curl -sf http://localhost:3000/v1/deliveries/$(DL_ID) | jq -r '.status'); \
	  echo "  [$$(date +%H:%M:%S)] status=$$STATUS"; \
	  if [ "$$STATUS" = "DELIVERED" ]; then break; fi; \
	  sleep 2; \
	done; \
	if [ "$$STATUS" != "DELIVERED" ]; then echo "ERROR: delivery did not reach DELIVERED"; exit 1; fi
	@echo ""
	@echo "=== Transition chain ==="
	@curl -sf http://localhost:3000/v1/deliveries/$(DL_ID) | \
	  jq -r '.transitions[] | "\(.from_status // "—") → \(.to_status)  [\(.actor)]  \(.created_at)"'
	@echo ""
	@echo "Dashboard → http://localhost:8080"

# Boots the full stack and runs test/chaos serially (vitest.chaos.config.ts
# already forces fileParallelism: false — two scenarios racing to
# kill/pause the same containers would be meaningless). Each scenario ends
# with assertInvariants(); a failing invariant fails that test with the
# offending rows printed inline, so vitest's own report doubles as the
# invariant summary — no separate printer needed.
chaos:
	$(MAKE) up
	@echo "Waiting for services..."
	@sleep 8
	$(MAKE) migrate
	@echo "\n=== Running chaos suite ==="
	pnpm test:chaos

# chaos-no-build: same as chaos but skips the image rebuild. Used by
# chaos-loop so images are only built once per loop invocation.
chaos-no-build:
	$(MAKE) up-no-build
	@echo "Waiting for services..."
	@sleep 8
	$(MAKE) migrate
	@echo "\n=== Running chaos suite ==="
	pnpm test:chaos

# Ten consecutive chaos runs, stopping at the first red one — this is the
# Week 2 exit gate ("chaos suite passes 10 consecutive runs"), not just a
# stress test. Images are built once at the top; each iteration restarts
# containers (idempotent, no rebuild) then runs the suite.
chaos-loop:
	@echo "=== Building images (once) ==="
	$(MAKE) up
	@for i in 1 2 3 4 5 6 7 8 9 10; do \
		echo "\n=== Chaos run $$i/10 ==="; \
		$(MAKE) chaos-no-build || { echo "\nChaos run $$i failed — stopping."; exit 1; }; \
	done
	@echo "\nAll 10 chaos runs passed."

# ---------------------------------------------------------------------------
# Load test targets (Week 3 Day 3 + Day 4)
# ---------------------------------------------------------------------------
#
# Full workflow:
#   1.  make loadtest-up                       — stack with CPU-pinned overrides
#   2.  make migrate                           — apply migrations (idempotent)
#   3.  Create a /ok endpoint and capture its ID:
#         EP=$(curl -sf -X POST http://localhost:3000/v1/endpoints \
#               -H 'Content-Type: application/json' \
#               -d '{"client_id":"loadtest","url":"http://test-receiver:4000/ok"}' \
#               | jq -r .id)
#   4.  make loadtest-baseline ENDPOINT_ID=$$EP
#   5.  make loadtest-lag          — p50/p95 delivery lag from Postgres
#   6.  make loadtest-zero-loss    — verify no events lost
#   7.  make loadtest-abuse        — 30% errors + 5% timeouts (creates own endpoint)
#   8.  make loadtest-expectation  — validate retry math after abuse test
#   9.  make loadtest-saturation ENDPOINT_ID=$$EP   — step VUs to find breaking point
#  10.  (in another terminal during any test) make loadtest-pools
# ---------------------------------------------------------------------------

# Bring up the stack with the load-test CPU/replica overrides.
loadtest-up:
	docker compose \
	  -f docker-compose.yml \
	  -f docker-compose.loadtest.yml \
	  up --build -d

loadtest-down:
	docker compose \
	  -f docker-compose.yml \
	  -f docker-compose.loadtest.yml \
	  down -v

# Run the baseline k6 test (ramp 0→2000 VUs, hold 10 min).
# Writes metrics to loadtest/result.json and loadtest/summary.json.
loadtest-baseline:
ifndef ENDPOINT_ID
	$(error ENDPOINT_ID is required. e.g.: make loadtest-baseline ENDPOINT_ID=<uuid>)
endif
	docker compose \
	  -f docker-compose.yml \
	  -f docker-compose.loadtest.yml \
	  --profile loadtest \
	  run --rm \
	  -e ENDPOINT_ID=$(ENDPOINT_ID) \
	  k6 run \
	    --summary-export=/results/summary.json \
	    /loadtest/baseline.js
	@echo "\nBaseline complete. Run 'make loadtest-lag' and 'make loadtest-zero-loss'."

# Print p50 / p95 delivery-to-DELIVERED lag for the last 20 minutes.
loadtest-lag:
	psql $(DATABASE_URL) -f scripts/delivery_lag.sql

# Verify that every k6 iteration produced a row in the events table.
# Reads K6_ITERATIONS from loadtest/summary.json if not set in env.
loadtest-zero-loss:
	@ITERS=$${K6_ITERATIONS:-$$(jq -r '.metrics.iterations.values.count // 0' loadtest/summary.json 2>/dev/null)}; \
	K6_ITERATIONS=$$ITERS \
	DATABASE_URL=$(DATABASE_URL) \
	CLIENT_ID=loadtest \
	bash scripts/zero-loss.sh

# Run the abuse test (30% HTTP 500 + 5% timeouts from the receiver).
# The chaos endpoint is created automatically in k6 setup().
loadtest-abuse:
	docker compose \
	  -f docker-compose.yml \
	  -f docker-compose.loadtest.yml \
	  --profile loadtest \
	  run --rm \
	  -e RECEIVER_URL=http://test-receiver:4000 \
	  k6 run \
	    --out json=/results/abuse-result.json \
	    --summary-export=/results/abuse-summary.json \
	    /loadtest/abuse.js
	@echo "\nAbuse test complete. Run 'make loadtest-expectation' to validate retry math."

loadtest-backpressure:
ifndef ENDPOINT_ID
	$(error ENDPOINT_ID is required. e.g.: make loadtest-backpressure ENDPOINT_ID=<uuid>)
endif
	docker compose \
	  -f docker-compose.yml \
	  -f docker-compose.loadtest.yml \
	  --profile loadtest \
	  run --rm \
	  -e ENDPOINT_ID=$(ENDPOINT_ID) \
	  k6 run \
	    --out json=/results/backpressure-result.json \
	    --summary-export=/results/backpressure-summary.json \
	    /loadtest/backpressure.js
	@echo "\nBackpressure test complete."

# Run the saturation test (step VUs 500→4000, find where p95 > 500ms).
loadtest-saturation:
ifndef ENDPOINT_ID
	$(error ENDPOINT_ID is required. e.g.: make loadtest-saturation ENDPOINT_ID=<uuid>)
endif
	docker compose \
	  -f docker-compose.yml \
	  -f docker-compose.loadtest.yml \
	  --profile loadtest \
	  run --rm \
	  -e ENDPOINT_ID=$(ENDPOINT_ID) \
	  k6 run \
	    --out json=/results/saturation-result.json \
	    --summary-export=/results/saturation-summary.json \
	    /loadtest/saturation.js
	@echo "\nSaturation test complete. Check loadtest/saturation-summary.json for the breaking VU count."

# Validate retry invariants after an abuse/chaos run.
loadtest-expectation:
	psql $(DATABASE_URL) -f scripts/expectation.sql

# Watch pgBouncer pool utilisation every 5s (run in a separate terminal).
loadtest-pools:
	PGBOUNCER_URL=postgres://webhooks:webhooks@localhost:5432/pgbouncer \
	bash scripts/show-pools.sh
                                                                     