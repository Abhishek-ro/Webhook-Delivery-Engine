# Build Plan — Distributed Webhook Delivery Engine

3 weeks, 3 phases. Each phase ends with exit criteria you can verify mechanically — if a criterion can't be checked by running a command or a test, it's not a criterion.

---

## Week 1 — Core Engine

Goal: an event POSTed to the API is durably persisted, queued, delivered to a live endpoint, and retried on failure. Ugly but correct.

| Day | Work |
|---|---|
| 1 | Repo scaffold: TypeScript strict, ESLint, Vitest. `docker-compose.yml` with postgres:16, pgbouncer (transaction mode, `default_pool_size=20`), redis:7, and the service topology pinned from day 1: `api`, `worker` (`deploy.replicas: 2`, `WORKER_CONCURRENCY=50`), `reconciler`, `dashboard` (nginx + Vite build, added week 3) — declared now so load-test results are reproducible. Migrations via `node-pg-migrate` — full schema from ARCHITECTURE.md §5 lands now, including the append-only tables and the `enqueued` outbox flag. Don't defer schema; everything downstream depends on it. |
| 2 | Ingestion API (Fastify): `POST /v1/endpoints`, `POST /v1/events` with zod validation, 256 KB payload cap, the two-layer idempotency check (Redis SETNX fast path + `ON CONFLICT` authoritative path), single-tx insert of `events` + `deliveries` + transition row. |
| 3 | BullMQ wiring: `webhook-delivery` queue with `jobId=delivery_id`, custom `webhook-backoff` strategy (jittered 10s/30s/2m/10m/1h), `attempts: 5`, `removeOnComplete` hygiene. Reconciler loop (`FOR UPDATE SKIP LOCKED` sweep of `enqueued=false`). |
| 4 | Worker: status re-read guard, `DELIVERING` transition, undici POST with 10s timeout + HMAC headers (`X-Webhook-Id`, `X-Webhook-Attempt`, `X-Webhook-Signature`), attempt row + status update in one tx, throw-on-failure to trigger BullMQ retry. Skip the Redis lock this week — BullMQ's job lock is enough until we deliberately break it in week 2. |
| 5 | Test receiver service (tiny express app: configurable status code, delay, flap mode) + integration tests: happy path E2E, 503-then-recover retry path, backoff timing assertions (fake timers against the strategy function, real timers for one slow test). |

**Exit criteria — week 1 is done when:**

- [ ] `docker compose up` → `curl POST /v1/events` → webhook arrives at test receiver with valid HMAC, `deliveries.status='DELIVERED'`, transition chain `PENDING→DELIVERING→DELIVERED` in SQL.
- [ ] Receiver set to 503: attempts land at jittered ~10s/30s/2m spacing (assert attempt timestamps in `delivery_attempts`).
- [ ] Same `Idempotency-Key` POSTed twice → one `events` row, one delivery, same `event_id` in both responses. Also true with Redis flushed between the two POSTs.
- [ ] `kill -9` the API between commit and enqueue (inject a crash flag for the test) → reconciler enqueues it within 90s, delivery completes.
- [ ] `kill -9` a worker mid-delivery → job is re-processed by the surviving worker, delivery completes.

---

## Week 2 — Hardening

Goal: every row of the failure table in ARCHITECTURE.md §6 has a test that forces it.

| Day | Work |
|---|---|
| 1 | Distributed lock: `wh:lock:{deliveryId}` SET NX PX 60000 with random token, `release_lock.lua`, `extend_lock.lua` + 20s heartbeat, `LOCK_LOST` outcome path. Lock-fail → silent return. |
| 2 | DLQ: `failed` handler (attempts exhausted → `webhook-dlq` + `DLQ` transition + alert hook), `POST /v1/dlq/:deliveryId/retry` with fresh `jobId:${deliveryId}:retry:${epoch}`, `GET /v1/dlq` listing. Alert hook = structured log always, optional outbound webhook fire-and-forget. |
| 3 | Circuit breaker (`wh:cb:*` keys, fail-fast `CIRCUIT_OPEN` attempts, single-probe half-open lifecycle per ARCHITECTURE.md §4) + per-endpoint token bucket (`token_bucket.lua`; rate-limited pickup = `job.moveToDelayed` + `DelayedError` — status unchanged, no attempt row, no transition row, counter metric only). |
| 4 | Chaos harness: extend test receiver with random-500 rate, timeout injection, slow-drip responses (body over 30s). Scripted fault scenarios: kill Redis mid-run, kill a worker mid-flight, stall a job past `lockDuration`, force lock expiry during a slow HTTP call. |
| 5 | Audit invariant suite — SQL checks that run after every chaos scenario: no delivery DELIVERED twice, no gap in `attempt_number`, every status change has exactly one transition row, no `DELIVERING` older than 5 min, `attempt_count` matches `count(delivery_attempts)`. Backpressure 429 path. |

**Exit criteria — week 2 is done when:**

- [ ] Chaos suite (all §6 scenarios) passes 10 consecutive runs; audit invariants hold after every run.
- [ ] Forced double-processing test (manually re-add a completed jobId variant + stall injection) produces **zero** second HTTP calls for a DELIVERED delivery — verified by receiver-side request log.
- [ ] Lock-expiry-mid-delivery test produces a `LOCK_LOST` attempt row and a successful later attempt, never a corrupt status.
- [ ] DLQ round-trip: 5 forced failures → DLQ + alert fired → manual retry API → DELIVERED, with the full transition chain including `actor='manual-retry'`.
- [ ] Redis flush mid-run loses zero events (reconciler drains; duplicates to receiver allowed, missing deliveries not).

---

## Week 3 — Dashboard, Load Testing, Polish

| Day | Work |
|---|---|
| 1 | Read API: keyset-paginated `GET /v1/deliveries` (filters: status, endpoint_id, time range), `GET /v1/deliveries/:id` (attempts + transitions), `GET /v1/stats` (counts by status + BullMQ queue depths). |
| 2 | React dashboard (Vite, single page, 2s polling — no websockets for v1): live status counts, delivery table with filters, drill-down panel showing the retry timeline (attempt #, outcome, http_status, latency, response body snippet). Internal-tool aesthetic: dense, monospace, no auth. |
| 3 | k6 suite: ramping-vus scenario to 2000 over 5m, hold 10m. Receiver in normal mode. Capture ingestion p50/p95/p99, error rate, and delivery lag (enqueue→DELIVERED, measured from Postgres timestamps, not k6). |
| 4 | k6 abuse scenarios: receiver at 30% random 500s + 5% timeouts under full load — verify retry behavior and DLQ counts match expectation math; backpressure scenario (drive queue depth past threshold, assert 429s); find the saturation point by stepping VUs up until p95 breaks 500ms, then explain *why* (expected: pgBouncer pool wait — verify against `pgbouncer SHOW POOLS` `maxwait`). |
| 5 | Write the saturation report (`LOADTEST.md`: graphs, the breaking number, the bottleneck evidence, what knob would move it). README polish: positioning, quickstart, ADR section (jittered backoff, append-only audit log, distributed locking vs single worker — the "why" paragraphs already drafted in ARCHITECTURE.md). |

**Exit criteria — week 3 is done when:**

- [ ] Dashboard shows a live chaos run end-to-end: events flowing PENDING→…→DELIVERED/DLQ with working filters and per-job retry history.
- [ ] k6 normal run at 2000 VUs: ingestion p95 and delivery lag reported with real numbers; zero lost events (k6 success count == `events` row count).
- [ ] Abuse run: observed retry counts within ±5% of the analytical expectation for a 30% failure rate; DLQ population matches `0.3^5` math on forced-permanent-failure endpoints.
- [ ] `LOADTEST.md` names a specific saturation point with evidence, not "it scales."
- [ ] Fresh-clone test: `docker compose up && make demo` works on a machine that isn't yours.

---

## The 3 Hardest Engineering Decisions

### 1. Where idempotency actually lives (and where it can't)

Four dedupe layers, each covering a different gap: Redis SETNX (fast, lossy), the `uq_events_client_idem` constraint (authoritative for ingestion), BullMQ `jobId` (dedupes enqueue races between API and reconciler), and the worker's post-lock status re-read (dedupes execution). The trap is believing any one of them gives exactly-once. It doesn't — a worker that delivers then dies before committing the attempt row **will** re-send. That's not a bug; it's the at-least-once contract.

**Watch out for:** the 24h Redis TTL vs a client retrying an idempotency key on day 2 (DB constraint saves you — make sure the `ON CONFLICT` path returns the original event, not an error); and the manual-retry jobId scheme — if you reuse the original jobId, BullMQ silently no-ops and your DLQ retry does nothing. Test that case explicitly.

### 2. Custom Redis lock on top of BullMQ's job lock — redundant until it isn't

BullMQ already locks active jobs, so the SETNX lock looks like belt-and-suspenders. It isn't: when a job stalls (worker GC pause, container freeze) past `lockDuration`, BullMQ hands it to another worker **while the first worker may still be mid-HTTP-call**. The Redis lock + token + heartbeat is what makes that scenario safe; the rule that matters is *never write a terminal status without holding the lock*, enforced by the token-checked release/extend scripts.

**Watch out for:** lock TTL (60s) vs HTTP timeout (10s) vs BullMQ `lockDuration` (90s) — these three numbers have an ordering requirement (HTTP timeout < lock TTL, heartbeat interval < lock TTL/2, lockDuration > worst-case processing) and getting it wrong fails silently until the chaos test forces it. Also: a failed lock acquisition must return *without throwing* — throwing burns one of the 5 attempts on a non-event.

### 3. Honest backpressure and an honest saturation number

The cheap path is to let the queue absorb everything and call it "scalable" — delivery lag grows unboundedly and nobody notices until it's hours. The deliberate decision: shed at the edge (429 past 50k queued jobs), cap per-endpoint concurrency so one dead-slow endpoint can't starve the pool, and run the load test until something actually breaks, then name it.

**Watch out for:** Compose-local co-location lies — k6, the API, workers, and Postgres sharing one machine means CPU contention masquerades as service saturation. Pin containers' CPU shares or run k6 from a second machine, and measure delivery lag from Postgres timestamps rather than trusting in-process metrics. The credibility of the whole "production-flavored" positioning rests on the load test report being real.
