# SCHEMA.md — Canonical Data Layer Reference

Single source of truth for the PostgreSQL schema, Redis key space, and Lua scripts.
If this file and ARCHITECTURE.md disagree, this file wins; fix the other one.

---

## 1. PostgreSQL

Migration tool: `node-pg-migrate`. All DDL below lands in migration 0001 (week 1, day 1).
Connections go through pgBouncer in **transaction mode** — no session-level features
(no `SET`, no advisory locks held across statements, no prepared statements via the pool).

### 1.1 `endpoints`

```sql
CREATE TABLE endpoints (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id       text NOT NULL,
  url             text NOT NULL,
  signing_secret  text NOT NULL,   -- plaintext in v1; v2: encrypt at rest (app-level AES-256-GCM, key from KMS)
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_endpoints_client ON endpoints (client_id);
```

Mutable. Deactivation (`is_active=false`) stops new deliveries at pickup time; in-flight
attempts complete. Endpoints are never deleted (deliveries FK them forever).

### 1.2 `events`

```sql
CREATE TABLE events (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id        text NOT NULL,
  idempotency_key  text NOT NULL,
  event_type       text NOT NULL,
  payload          jsonb NOT NULL,           -- capped at 256 KB at the API edge
  received_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_events_client_idem UNIQUE (client_id, idempotency_key)
);
```

Append-only in practice (no UPDATE path exists). `uq_events_client_idem` is the
**authoritative** idempotency layer — the Redis fast path is advisory only.
Ingestion uses `INSERT ... ON CONFLICT (client_id, idempotency_key) DO NOTHING`
followed by a select of the surviving row, so a duplicate POST returns the original
`event_id`, never an error.

### 1.3 `deliveries` — the only hot-mutable table

```sql
CREATE TABLE deliveries (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id         uuid NOT NULL REFERENCES events(id),
  endpoint_id      uuid NOT NULL REFERENCES endpoints(id),
  status           text NOT NULL DEFAULT 'PENDING'
                     CHECK (status IN ('PENDING','DELIVERING','DELIVERED','FAILED','DLQ')),
  attempt_count    int  NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz,
  enqueued         boolean NOT NULL DEFAULT false,   -- outbox flag; reconciler sweeps false
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  -- v1 is strictly 1 event : 1 delivery (ARCHITECTURE.md §3). Kept as dup-row
  -- insurance now, natural key if subscription fan-out arrives in v2.
  CONSTRAINT uq_deliveries_event_endpoint UNIQUE (event_id, endpoint_id)
);

-- Reconciler sweep: tiny partial index, stays hot in memory
CREATE INDEX idx_deliveries_unenqueued ON deliveries (created_at) WHERE enqueued = false;

-- Dashboard live feed + filters
CREATE INDEX idx_deliveries_status_updated   ON deliveries (status, updated_at DESC);
CREATE INDEX idx_deliveries_endpoint_created ON deliveries (endpoint_id, created_at DESC);

-- Postgres does NOT auto-index FK columns
CREATE INDEX idx_deliveries_event ON deliveries (event_id);
```

Updated only by the worker that holds `wh:lock:{id}`, the reconciler (`enqueued` flag
only), or the manual-retry API. One row per delivery — never more, enforced by the
unique constraint.

### 1.4 `delivery_attempts` — append-only

```sql
CREATE TABLE delivery_attempts (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  delivery_id     uuid NOT NULL REFERENCES deliveries(id),
  attempt_number  int  NOT NULL,
  -- RATE_LIMITED is deliberately NOT an outcome: a rate-limited pickup is requeued
  -- without consuming an attempt and writes no rows at all.
  outcome         text NOT NULL
                    CHECK (outcome IN ('SUCCESS','HTTP_ERROR','TIMEOUT','CONN_ERROR','CIRCUIT_OPEN','LOCK_LOST')),
  http_status     int,
  response_body   text,                      -- truncated to 4 KB before insert
  error_message   text,
  latency_ms      int,
  started_at      timestamptz NOT NULL,
  finished_at     timestamptz NOT NULL,
  CONSTRAINT uq_attempts UNIQUE (delivery_id, attempt_number)
);

CREATE INDEX idx_attempts_delivery ON delivery_attempts (delivery_id, attempt_number);
CREATE INDEX idx_attempts_brin     ON delivery_attempts USING brin (started_at);
```

No UPDATE, no DELETE, ever. The attempt row and the corresponding `deliveries.status`
update commit **in the same transaction** — there is never an attempt without a status
that reflects it.

### 1.5 `delivery_transitions` — append-only audit log

```sql
CREATE TABLE delivery_transitions (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  delivery_id  uuid NOT NULL REFERENCES deliveries(id),
  from_status  text,                          -- NULL on creation
  to_status    text NOT NULL,
  reason       text,                          -- 'http_503', 'timeout_10s', 'attempts_exhausted', ...
  actor        text NOT NULL DEFAULT 'worker'
                 CHECK (actor IN ('worker','api','reconciler','manual-retry')),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_transitions_delivery ON delivery_transitions (delivery_id, id);
CREATE INDEX idx_transitions_brin     ON delivery_transitions USING brin (created_at);
```

Every status change writes exactly one row, in the same transaction as the change.
Rate-limited requeues write **nothing** here (status didn't change).

### 1.6 State machine

```
            (api)                (worker)              (worker)
  [created] ──→ PENDING ──→ DELIVERING ──→ DELIVERED            terminal
                   ↑              │
                   │              ↓ non-2xx / timeout / lock lost
                   │           FAILED ──→ DELIVERING             (BullMQ retry)
                   │              │
                   │              ↓ attempt 5 failed
    (manual-retry) └────────── DLQ                               terminal-until-human
```

Legal transitions, enforced in code and auditable in SQL:

| from | to | actor | reason examples |
|---|---|---|---|
| ∅ | PENDING | api | `created` |
| PENDING | DELIVERING | worker | `attempt_1` |
| FAILED | DELIVERING | worker | `attempt_n` |
| DELIVERING | DELIVERED | worker | `http_200` |
| DELIVERING | FAILED | worker | `http_503`, `timeout_10s`, `lock_lost` |
| FAILED | DLQ | worker | `attempts_exhausted` |
| DLQ | PENDING | manual-retry | `manual_retry` |

### 1.7 Audit invariants (run after every chaos scenario)

```sql
-- I1: no delivery delivered twice
SELECT delivery_id FROM delivery_transitions
WHERE to_status = 'DELIVERED' GROUP BY delivery_id HAVING count(*) > 1;

-- I2: no gaps in attempt numbering
SELECT delivery_id FROM delivery_attempts
GROUP BY delivery_id HAVING max(attempt_number) != count(*);

-- I3: attempt_count matches reality
SELECT d.id FROM deliveries d
LEFT JOIN delivery_attempts a ON a.delivery_id = d.id
GROUP BY d.id, d.attempt_count HAVING d.attempt_count != count(a.id);

-- I4: no delivery stuck DELIVERING
SELECT id FROM deliveries
WHERE status = 'DELIVERING' AND updated_at < now() - interval '5 minutes';

-- I5: terminal DELIVERED has a SUCCESS attempt
SELECT d.id FROM deliveries d
WHERE d.status = 'DELIVERED' AND NOT EXISTS (
  SELECT 1 FROM delivery_attempts a
  WHERE a.delivery_id = d.id AND a.outcome = 'SUCCESS');
```

All five must return zero rows. They are the week-2 exit gate.

---

## 2. Redis Key Space

Prefix everything with `wh:` (BullMQ owns `bull:`). All keys have TTLs — a wiped or
expired Redis must never cause incorrect behavior, only degraded speed.

| Key | Type | Written by | TTL | Semantics |
|---|---|---|---|---|
| `wh:idem:{clientId}:{idemKey}` | string → event_id | API (`SET NX EX 86400`) | 24 h | Fast-path dedupe. Miss falls through to `uq_events_client_idem`. |
| `wh:lock:{deliveryId}` | string → random 16-byte hex token | worker (`SET NX PX 60000`) | 60 s | Per-delivery mutex. Release/extend only via token-checked Lua. |
| `wh:cb:{endpointId}:fails` | int counter | worker (`INCR` + `EXPIRE 300`) | 300 s | Rolling failure window. ≥ 20 → open breaker. |
| `wh:cb:{endpointId}:open` | "1" | worker (`SET EX 60`) | 60 s | Breaker open. Expiry = half-open. |
| `wh:cb:{endpointId}:probe` | "1" | worker (`SET NX EX 10`) | 10 s | Half-open probe slot; SETNX winner sends the one real request. |
| `wh:rl:{endpointId}` | hash `{tokens, refilled_at}` | `token_bucket.lua` | 120 s idle | Per-endpoint in-flight cap (50). Refill on release. |
| `bull:webhook-delivery:*` | various | BullMQ | managed | Queue internals. `removeOnComplete: {age: 3600, count: 10000}`. |
| `bull:webhook-dlq:*` | various | BullMQ | managed | DLQ. `removeOnFail: false` — kept until manually resolved. |

**Job ID conventions** (BullMQ dedupes on jobId — this is load-bearing):

| Queue | jobId | Why |
|---|---|---|
| `webhook-delivery` | `{deliveryId}` | API and reconciler can race `queue.add` harmlessly. |
| `webhook-delivery` (manual retry) | `{deliveryId}:retry:{epochMs}` | Fresh jobId = fresh attempt budget. Reusing the original jobId would silently no-op. |
| `webhook-dlq` | `{deliveryId}` | One DLQ entry per delivery. |

---

## 3. Lua Scripts

Loaded once at worker boot via `SCRIPT LOAD`, invoked by SHA.

### 3.1 `release_lock.lua`

```lua
-- KEYS[1] = wh:lock:{deliveryId}   ARGV[1] = token
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
```

Return 0 means the lock was lost (TTL expired, someone else owns it). Caller logs it;
if delivery work was about to be committed, abort and record `LOCK_LOST`.

### 3.2 `extend_lock.lua`

```lua
-- KEYS[1] = wh:lock:{deliveryId}   ARGV[1] = token   ARGV[2] = ttl_ms
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0
```

Called by the heartbeat every 20s while HTTP is in flight. Return 0 → abort the
delivery, record `LOCK_LOST`, throw for retry.

### 3.3 `token_bucket.lua`

```lua
-- KEYS[1] = wh:rl:{endpointId}   ARGV[1] = max_tokens (50)   ARGV[2] = ttl_s (120)
local tokens = tonumber(redis.call('HGET', KEYS[1], 'tokens') or ARGV[1])
if tokens <= 0 then return -1 end
redis.call('HSET', KEYS[1], 'tokens', tokens - 1)
redis.call('EXPIRE', KEYS[1], ARGV[2])
return tokens - 1
```

Token released (`HINCRBY tokens 1`, capped at max) in the worker's `finally` block.
Return -1 → rate-limited pickup: `moveToDelayed(+5s jitter)` + `DelayedError`,
no attempt consumed, no rows written.

---

## 4. Ordering Requirements (the numbers that must stay ordered)

| Constraint | Values | Breaks if violated |
|---|---|---|
| HTTP timeout < Redis lock TTL | 10 s < 60 s | Worker can finish (or abort) before its lock can vanish mid-write. |
| Heartbeat interval < lock TTL / 2 | 20 s < 30 s | One missed beat doesn't lose the lock. |
| BullMQ `lockDuration` > worst-case processing | 90 s > 10 s HTTP + tx + margin | BullMQ doesn't declare a healthy worker stalled. |
| Reconciler grace > enqueue path latency | 60 s ≫ ~50 ms | Sweep never races a healthy in-flight `queue.add`. |
| `removeOnComplete.age` ≥ dashboard "recent" window | 3600 s | Completed-job inspection in BullMQ UI stays possible for an hour. |

Change any number on the left, re-derive the whole column. There's a unit test
(`config.invariants.test.ts`) that asserts these orderings from the actual config values.
