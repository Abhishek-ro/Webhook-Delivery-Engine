# Runbook — Webhook Delivery Engine

On-call crib sheet. Jump to the section for your alert.

---

## Quick health check

```bash
# Is the API alive?
curl http://localhost:3000/healthz          # → {"ok":true}
curl http://localhost:3000/readyz           # → {"postgres":"ok","redis":"ok"}

# Live delivery counts + queue depths
curl -s http://localhost:3000/v1/stats | jq .

# Dashboard (visual)
open http://localhost:8080
```

---

## DLQ drain

### "DLQ is growing"

Dead-letter entries mean deliveries exhausted all 5 attempts. Fix the receiver first, then retry.

```bash
# See what's in the DLQ
curl -s http://localhost:3000/v1/dlq | jq '.data[] | {id, event_type, attempt_count, dlq_entered_at}'

# Retry a single delivery
curl -sf -X POST http://localhost:3000/v1/dlq/<delivery_id>/retry | jq .

# Bulk retry all DLQ entries (careful — this re-drives traffic to the receiver)
curl -s http://localhost:3000/v1/dlq | jq -r '.data[].id' | while read id; do
  echo "Retrying $id..."
  curl -sf -X POST "http://localhost:3000/v1/dlq/$id/retry" | jq -r '.status // .error.code'
done
```

The manual retry creates a fresh `PENDING` transition row with `actor=manual-retry` and
gives the delivery a new attempt budget (attempts reset to 0 effectively — a new job is
enqueued). The original attempt history is preserved in `delivery_attempts`.

---

## Delivery stuck in PENDING or DELIVERING

### "Delivery hasn't moved for > 2 minutes"

```bash
# Check the delivery detail
curl -s http://localhost:3000/v1/deliveries/<delivery_id> | jq '{status, attempt_count, next_attempt_at, transitions}'

# Is the worker running?
docker compose ps worker

# Worker logs for this delivery
docker compose logs worker | grep <delivery_id> | tail -20
```

**PENDING for > 60 s:** The reconciler should have re-enqueued it. Check:
```bash
docker compose logs reconciler | tail -20
```

**Stuck in DELIVERING:** The worker has the Redis lock. If the worker process died,
the lock TTL (60 s default) will expire and BullMQ stalled-job recovery will re-queue
it (within `BULLMQ_STALLED_INTERVAL_MS`, default 30 s). Total max stall recovery: ~90 s.

---

## Backpressure / queue depth alert

### "`backpressure_active: true`" in `/v1/stats`

The BullMQ `webhook-delivery` queue has more than `BACKPRESSURE_QUEUE_LIMIT` (default 50 000)
waiting + delayed jobs. The API is returning `429 Too Many Requests` to new events.

**Short-term:** Scale workers up.
```bash
docker compose up --scale worker=4 -d
```

**Check pgBouncer pool utilisation** (is the bottleneck DB connections, not workers?):
```bash
make loadtest-pools
# or
psql postgres://webhooks:webhooks@localhost:5432/pgbouncer -c "SHOW POOLS;"
```

If `cl_waiting > 0` or `maxwait > 0`, the pool is exhausted. Raise `DEFAULT_POOL_SIZE`
in `docker-compose.yml` (pgbouncer service, `DEFAULT_POOL_SIZE` env var) and restart pgBouncer.

---

## Receiver returning 5xx / timeouts

### "High FAILED count, deliveries cycling"

The system will retry automatically (up to 5 attempts, exponential backoff). No action
needed unless the receiver is confirmed broken for > 1 hour — in that case the last retry
at backoff slot 5 (3 600 s = 1 h) will DLQ the delivery.

To inspect what the receiver is returning:
```bash
# Attempt outcomes for a specific delivery
curl -s http://localhost:3000/v1/deliveries/<delivery_id> | jq '.attempts[] | {attempt_number, outcome, http_status, error_message, latency_ms}'
```

**Circuit breaker open?** If an endpoint has triggered the circuit breaker
(`CB_FAIL_THRESHOLD` failures in `CB_WINDOW_SECONDS`), new deliveries to it will record
a `CIRCUIT_OPEN` attempt and back off immediately.

```bash
# Check circuit breaker key in Redis
docker compose exec redis redis-cli GET wh:cb:<endpoint_id>:open
# → "1" means open, nil means closed
```

Manually close the circuit breaker (only do this when the receiver is confirmed healthy):
```bash
docker compose exec redis redis-cli DEL wh:cb:<endpoint_id>:open
```

---

## Scale workers

```bash
# Add more workers (each gets concurrency=50 job slots by default)
docker compose up --scale worker=4 -d

# Check active workers
docker compose ps worker
```

Workers are stateless. Scale up or down at any time — the Redis lock prevents two workers
from processing the same delivery simultaneously.

---

## Redis wiped / Redis restart

1. In-flight workers will lose their lock heartbeat. Locks expire after `LOCK_TTL_MS` (default 60 s).
2. BullMQ stalled-job recovery will re-queue active jobs within `BULLMQ_STALLED_INTERVAL_MS`.
3. The idempotency seen-set is lost — duplicate events within the 24 h TTL window will rely
   on the Postgres `ON CONFLICT (client_id, idempotency_key) DO NOTHING` constraint instead of
   the Redis fast-path. No events will be duplicated; the Postgres constraint is the real gate.
4. The reconciler sweep (30 s) will catch any `enqueued=false` rows and re-enqueue them.

**Net result:** brief latency spike, possible duplicate *delivery attempts* (not duplicate deliveries —
`DELIVERED` status check in the worker prevents re-delivery), full recovery within 2 minutes.

---

## Postgres maintenance

### Check oldest pending delivery age

```bash
curl -s http://localhost:3000/v1/stats | jq '.oldest_pending_age_s'
# > 300 seconds (5 min) warrants investigation
```

### Vacuum / bloat

The `deliveries` and `delivery_attempts` tables are append-heavy with frequent updates to
`deliveries.status`. Run `ANALYZE` after large load tests:

```bash
psql $DATABASE_URL -c "ANALYZE deliveries, delivery_attempts, delivery_transitions;"
```

### Useful queries

```sql
-- Delivery lag right now (deliveries currently in flight)
SELECT
  count(*) AS in_flight,
  max(EXTRACT(EPOCH FROM (now() - created_at)))::int AS oldest_s
FROM deliveries
WHERE status IN ('PENDING', 'DELIVERING');

-- DLQ entries in last 24h
SELECT count(*), endpoint_id
FROM deliveries
WHERE status = 'DLQ' AND updated_at > now() - INTERVAL '24 hours'
GROUP BY endpoint_id ORDER BY count DESC;

-- Retry math sanity check (see scripts/expectation.sql for full version)
SELECT status, count(*), avg(attempt_count)::numeric(5,2) AS avg_attempts
FROM deliveries GROUP BY status ORDER BY status;
```

---

## Useful make targets

```bash
make up               # start everything
make down             # stop + destroy volumes
make migrate          # run pending migrations
make test             # unit + integration tests
make chaos            # chaos suite
make loadtest-up      # start CPU-pinned load test stack
make loadtest-pools   # watch pgBouncer pools
make loadtest-lag     # print delivery lag percentiles
make loadtest-expectation  # validate retry invariants
```
