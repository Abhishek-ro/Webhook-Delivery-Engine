# Distributed Webhook Delivery Engine

A production-grade, at-least-once webhook delivery system built to handle the hard parts:
idempotent ingestion, distributed locking across worker replicas, exponential backoff with
a DLQ, pgBouncer connection pooling, a circuit breaker, and a live React dashboard —
all running in Docker Compose with a full chaos + load test suite.

**Stack:** Node.js · TypeScript (strict) · Fastify · BullMQ · Redis · PostgreSQL · pgBouncer · React · k6

---

## Why this exists

Webhook delivery looks simple until you need to handle:

- **Crash between persist and enqueue** — event saved but job lost. Fixed by the outbox reconciler.
- **Two workers racing on the same retry** — fixed by a per-delivery Redis lock with heartbeat.
- **Client sends the same event twice** — fixed by idempotency enforced in both Redis and Postgres.
- **Receiver is down for an hour** — fixed by exponential backoff (10 s → 30 s → 2 min → 10 min → 1 h) and a dead-letter queue.
- **pgBouncer in transaction mode** — no advisory locks, no `SET` commands, no session state. All synchronisation goes through application-level Redis locks and Lua scripts.

---

## Architecture

```
Client
  │
  ▼
POST /v1/events
  │
  ├─ Redis SETNX (fast-path idempotency)
  │
  ├─ Postgres transaction
  │     INSERT events + deliveries + transition(PENDING)
  │     SET enqueued = false
  │
  ├─ BullMQ enqueue  (jobId = delivery_id)
  │     SET enqueued = true
  │
  └─ 202 { event_id, delivery_id }

Reconciler (every 30 s)
  └─ SELECT ... WHERE enqueued = false FOR UPDATE SKIP LOCKED
       → re-enqueue, SET enqueued = true       ← closes the outbox gap

Worker (N replicas, concurrency 50 each)
  ├─ Redis SETNX lock  (per delivery_id, 60 s TTL, heartbeat every 20 s)
  ├─ Re-read delivery from Postgres
  ├─ Circuit-breaker check  (per endpoint_id, Redis bit)
  ├─ Rate-limit check       (token bucket, Lua script)
  ├─ transition → DELIVERING
  ├─ HTTP POST  (HMAC-SHA256 signature, 10 s timeout)
  ├─ Record delivery_attempts + transition row  (one transaction)
  ├─ 2xx  → DELIVERED, ack
  └─ Non-2xx / timeout → FAILED, throw → BullMQ schedules retry

Exhausted (attempt 5 fails)
  └─ webhook-dlq queue → alert hook → manual retry API

React Dashboard  (port 8080)
  ├─ StatusTiles  — live counts + queue depths, polls every 2 s
  ├─ DeliveryTable — keyset-paginated list, filters by status/endpoint/date
  ├─ DetailPanel  — attempt timeline + transition chain
  └─ DLQ view    — per-row retry button
```

---

## Key Design Decisions

### 1. Postgres is the only source of truth

Redis holds advisory caches (idempotency seen-set, locks, circuit-breaker bits). If Redis
is wiped, the system degrades gracefully: the reconciler re-enqueues anything that slipped
through, and the Postgres `ON CONFLICT` constraint is the real idempotency gate. No event
is lost.

### 2. Outbox pattern without a framework

Event + delivery rows are inserted in one transaction with `enqueued = false`. The
reconciler sweeps rows that were never set to `true` — closing the gap between `INSERT` and
`queue.add` without needing Debezium or Kafka. Cost: one 30 s sweep cycle latency at most.

### 3. pgBouncer in transaction mode — no session features

Connections are returned to the pool after each statement. This rules out advisory locks,
`SET` commands, and prepared statements. All cross-request state (idempotency, delivery
locking) uses application-level Redis primitives (SETNX + Lua scripts). The app never
assumes a connection is the same across two statements.

### 4. Per-delivery Redis lock with heartbeat

`SETNX wh:lock:{deliveryId} {token} PX 60000` before every HTTP call. The worker renews
the lock every 20 s while the request is in flight. If the worker crashes mid-delivery, the
lock expires and BullMQ's stalled-job recovery re-queues the job — at which point the next
worker checks `delivery.status` and skips if already `DELIVERED`. At-least-once is
guaranteed; double-fire is prevented.

### 5. Attempt budget is for delivery decisions only

Rate-limited pickups do not consume an attempt. The worker calls
`job.moveToDelayed(now + 5 s, token)` and returns — no `delivery_attempts` row, no
transition. The attempt counter and audit trail are reserved for actual HTTP outcomes.

### 6. Keyset pagination on `(updated_at DESC, id DESC)`

The delivery list uses keyset cursors instead of `OFFSET`. Concurrent inserts between pages
don't corrupt the walk because the cursor encodes a stable total order. Tested with a
mid-walk insert in `test/integration/pagination.test.ts`.

---

## Quickstart

```bash
# Prerequisites: Docker, pnpm, Node 20+

git clone <repo-url>
cd webhookDelivery

# Boot the full stack (API + worker × 2 + reconciler + postgres + redis + pgbouncer + dashboard)
make up

# Apply migrations
make migrate

# Register an endpoint
# Note: signing_secret must match what the receiver verifies against.
# The bundled test-receiver uses "whsec_test_receiver_secret" by default.
EP=$(curl -sf -X POST http://localhost:3000/v1/endpoints \
      -H 'Content-Type: application/json' \
      -d '{"client_id":"demo","url":"http://test-receiver:4000/ok","signing_secret":"whsec_test_receiver_secret"}' \
      | jq -r .id)

# Send an event
curl -sf -X POST http://localhost:3000/v1/events \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: demo-001' \
  -d "{\"client_id\":\"demo\",\"event_type\":\"payment.completed\",\"payload\":{\"amount\":100},\"endpoint_id\":\"$EP\"}" \
  | jq .

# Watch it deliver
open http://localhost:8080

# Or check the transition chain in the terminal
make demo
```

---

## API

| Method | Path | Description |
|---|---|---|
| `POST` | `/v1/endpoints` | Register a webhook endpoint |
| `POST` | `/v1/events` | Ingest an event (idempotent via `Idempotency-Key` header) |
| `GET` | `/v1/deliveries` | List deliveries (keyset paginated, filterable) |
| `GET` | `/v1/deliveries/:id` | Full delivery detail — attempts + transition chain |
| `GET` | `/v1/dlq` | List dead-letter queue entries |
| `POST` | `/v1/dlq/:id/retry` | Manually retry a DLQ delivery |
| `GET` | `/v1/stats` | Live counts by status + queue depths |
| `GET` | `/healthz` | Liveness |
| `GET` | `/readyz` | Readiness (checks Postgres + Redis) |

Full spec: [`API_SPEC.md`](API_SPEC.md)

---

## Receiving Webhooks

Your receiver gets a signed `POST` to the registered URL:

```
POST {your_url}
Content-Type:       application/json
X-Webhook-Id:       <delivery_id>   ← dedupe on this; duplicates are when, not if
X-Webhook-Attempt:  3
X-Webhook-Timestamp: 1781430000     ← unix seconds
X-Webhook-Signature: sha256=<hex>
```

**Verify the signature** with constant-time compare, reject timestamps older than 5 minutes:

```ts
import { createHmac, timingSafeEqual } from 'crypto';

function verify(secret: string, timestamp: string, rawBody: string, sig: string): boolean {
  const expected = 'sha256=' + createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
```

**Three rules:**
- Return any `2xx` within 10 s. Over 10 s = timeout = retry = duplicate.
- Dedupe on `X-Webhook-Id`. At-least-once means you *will* see duplicates.
- Do heavy work async — ack immediately, process after.

---

## Testing

```bash
make test           # unit + integration tests (vitest)
make chaos          # chaos suite (kill worker, pause Redis, etc.)
make chaos-loop     # 10 consecutive chaos runs — the Week 2 exit gate
```

The integration tests require the Docker stack (`make up && make migrate` first).
The chaos suite uses `dockerode` to kill/pause/restart containers mid-flight and
asserts database invariants after each scenario.

---

## Load Testing

See [`LOADTEST.md`](LOADTEST.md) for full methodology and results.

```bash
make loadtest-up
make migrate
EP=$(curl -sf -X POST http://localhost:3000/v1/endpoints \
      -H 'Content-Type: application/json' \
      -d '{"client_id":"loadtest","url":"http://test-receiver:4000/ok","signing_secret":"whsec_test_receiver_secret"}' \
      | jq -r .id)

make loadtest-baseline ENDPOINT_ID=$EP   # 15 min, 2 000 VUs
make loadtest-abuse                       # bad receiver scenario
make loadtest-saturation ENDPOINT_ID=$EP  # find breaking point
```

---

## Project Structure

```
src/
  api/          Fastify app — endpoint, event, DLQ, delivery, stats routes
  worker/       BullMQ processor — lock, circuit breaker, rate limit, HTTP, signature
  reconciler/   Outbox sweep — re-enqueues deliveries that slipped through
  db/           Postgres query functions (no ORM)
  queue/        BullMQ queue definitions
  redis/        Redis client + Lua scripts (lock, token bucket, circuit breaker)
  shared/       Config (Zod), logger, memoTtl
  test-receiver/ Stub HTTP server for integration/chaos/load tests

dashboard/      React + Vite — status tiles, delivery table, detail panel, DLQ view
migrations/     node-pg-migrate SQL files
test/
  unit/         Pure function tests
  integration/  Tests that hit real Postgres + API
  chaos/        Dockerode-based fault injection tests
loadtest/       k6 scripts (baseline, abuse, saturation) + shared lib
scripts/        SQL analysis + shell utilities
```

---

## Ops

See [`docs/RUNBOOK.md`](docs/RUNBOOK.md) for the on-call crib sheet.

---

## Documentation

| Doc | Contents |
|---|---|
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | System design — components, data flow, failure modes |
| [`API_SPEC.md`](API_SPEC.md) | Full REST API + outbound delivery contract |
| [`SCHEMA.md`](SCHEMA.md) | Postgres schema, indexes, Redis key patterns, Lua scripts |
| [`LOADTEST.md`](LOADTEST.md) | Load test methodology + results |
| [`docs/RUNBOOK.md`](docs/RUNBOOK.md) | On-call crib sheet |
