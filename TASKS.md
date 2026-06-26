# TASKS.md — Build Checklist

Granular, ordered, checkbox-driven. Derived from PLAN.md; specs live in
ARCHITECTURE.md / SCHEMA.md / API_SPEC.md. Check things off in order — later tasks
assume earlier ones.

---

## Week 1 — Core Engine

### Day 1 — Scaffold + infrastructure

- [ ] `pnpm init`, TypeScript strict mode, ESLint, Vitest, `tsx` for dev
- [ ] Repo layout: `src/api/`, `src/worker/`, `src/reconciler/`, `src/db/`, `src/redis/`, `src/shared/`, `test/`, `loadtest/`, `dashboard/`
- [ ] `docker-compose.yml`: `postgres:16`, `pgbouncer` (transaction mode, `default_pool_size=20`), `redis:7`, `api`, `worker` (`deploy.replicas: 2`, env `WORKER_CONCURRENCY=50`), `reconciler`, `test-receiver`
- [ ] `node-pg-migrate` setup + migration 0001: full schema from SCHEMA.md §1 (all 5 tables, all indexes, in one migration)
- [ ] Config module: typed env loading (zod), single place for every tunable (timeouts, TTLs, pool sizes, backoff table)
- [ ] `config.invariants.test.ts`: assert the ordering table from SCHEMA.md §4 against real config values
- [ ] Makefile: `make up`, `make migrate`, `make test`, `make demo`
- [ ] CI: lint + typecheck + unit tests on push

### Day 2 — Ingestion API

- [ ] Fastify app factory; `GET /healthz`, `GET /readyz` (pg + redis ping)
- [ ] `POST /v1/endpoints` (+ secret generation), `GET /v1/endpoints`, `PATCH /v1/endpoints/:id` per API_SPEC.md §1
- [ ] Error envelope middleware (`{ error: { code, message, details } }`), zod validation → 400 with issues
- [ ] `POST /v1/events`: require `Idempotency-Key`, 256 KB cap (413), endpoint existence (404) + active check (409)
- [ ] Redis fast-path dedupe: `SET wh:idem:{client}:{key} <event_id> NX EX 86400`
- [ ] Authoritative dedupe: single-tx `INSERT events ON CONFLICT DO NOTHING` → fetch survivor → INSERT `deliveries` (`enqueued=false`) + `PENDING` transition row
- [ ] Duplicate path returns 200 `{ duplicate: true }` with original ids; first path 202
- [ ] Unit tests: dup key (Redis hit), dup key (Redis flushed, DB constraint hit), oversized payload, inactive endpoint

### Day 3 — Queue + reconciler

- [ ] `webhook-delivery` queue: `attempts: 5`, custom `webhook-backoff` strategy (jittered 10s/30s/2m/10m/1h), `removeOnComplete: {age:3600, count:10000}`, `removeOnFail: false`
- [ ] Enqueue after commit with `jobId = delivery_id`, then `UPDATE deliveries SET enqueued=true`
- [ ] Backoff strategy unit test: 1000 samples per attempt, assert all within [base/2, base] and mean ≈ 0.75·base
- [ ] Reconciler service: every 30s, `SELECT id FROM deliveries WHERE enqueued=false AND created_at < now()-interval '60 seconds' FOR UPDATE SKIP LOCKED LIMIT 500` → enqueue (same jobId) → flag
- [ ] Test: insert with `enqueued=false`, assert reconciler enqueues exactly once even with two reconciler instances running

### Day 4 — Worker

- [ ] Worker setup: `concurrency: 50`, `lockDuration: 90000`, `stalledInterval: 30000`, `maxStalledCount: 1`
- [ ] Processor skeleton: load delivery + endpoint, **status re-read guard** (`DELIVERED` → ack no-op)
- [ ] `→ DELIVERING` transition + row (single tx)
- [ ] undici client: 10 s total timeout, keep-alive pool, no redirect following
- [ ] HMAC signing per API_SPEC.md §6 (`timestamp.body`, constant-time verify helper for the test receiver)
- [ ] Outcome recording: attempt row + status update + transition row in ONE tx; truncate `response_body` to 4 KB
- [ ] 2xx → `DELIVERED` + ack; failure → `FAILED` + throw (hands scheduling to BullMQ)
- [ ] `attempt_count` increment + `next_attempt_at` write on failure

### Day 5 — Test receiver + integration tests

- [x] `test-receiver`: express app — `/ok`, `/fail/:status`, `/timeout/:ms`, `/flap` (fail N then succeed), request log endpoint for assertions, signature verification
- [x] E2E: POST event → receiver gets valid signed webhook → SQL shows `PENDING→DELIVERING→DELIVERED`
- [x] E2E: 503-then-recover → attempt spacing matches jittered schedule (assert from `delivery_attempts` timestamps)
- [x] E2E: duplicate POST (with and without Redis flush between) → one event row, same event_id
- [x] Crash test: API crash-flag between commit and enqueue → reconciler completes delivery within 90 s
- [x] Crash test: `docker kill` one worker mid-delivery → surviving worker completes it
- [ ] **Week 1 exit criteria from PLAN.md all green** *(implemented and reasoned through carefully, but not yet run green end-to-end by anyone — verify with `docker compose up` + `pnpm test:int` before trusting this)*

---

## Week 2 — Hardening

### Day 1 — Distributed lock

- [x] `wh:lock:{deliveryId}`: `SET NX PX 60000` with crypto-random token
- [x] `release_lock.lua` + `extend_lock.lua` (SCHEMA.md §3), loaded via `SCRIPT LOAD` at boot
- [x] Heartbeat: extend every 20 s while HTTP in flight; extension failure → abort, record `LOCK_LOST`, throw
- [x] Lock-acquisition failure → silent return (no throw — must not burn an attempt)
- [x] Rule enforced in code: terminal status writes happen only while holding the lock
- [x] Tests: token mismatch can't release; expiry mid-flight → `LOCK_LOST` row + later successful attempt *(under test/integration/, not test/unit/ — see MASTER_CHECKLIST.md note)*

### Day 2 — DLQ

- [x] Worker `failed` handler: `attemptsMade >= 5` → `→ DLQ` transition + add to `webhook-dlq` (jobId = deliveryId)
- [x] Alert hook: structured log always; optional `ALERT_WEBHOOK_URL` fire-and-forget (failures logged, never retried)
- [x] `GET /v1/dlq`, `POST /v1/dlq/:id/retry` per API_SPEC.md §4 — fresh jobId `{id}:retry:{epochMs}`, 409 on non-DLQ
- [x] Test: reused original jobId silently no-ops (the trap) — assert fresh-jobId scheme actually re-delivers
- [x] Test: attempt numbering continues after manual retry (6, 7, ...) *(required fixing a real bug in processor.ts — see MASTER_CHECKLIST.md Week 1 Day 4 note)*

### Day 3 — Circuit breaker + rate limiting

- [x] Breaker per SCHEMA.md lifecycle: fails counter (INCR+EXPIRE 300), open at ≥20 (SET EX 60), `CIRCUIT_OPEN` fail-fast
- [x] Half-open: `SET wh:cb:{id}:probe NX EX 10` — winner probes, losers stay `CIRCUIT_OPEN`
- [x] Probe success → DEL fails+probe; probe failure → re-open immediately (no 20-failure wait)
- [x] `token_bucket.lua`: 50 in-flight cap per endpoint, release in `finally`
- [x] Rate-limited pickup: `job.moveToDelayed(now+5s±jitter, token)` + `DelayedError` — **status untouched, zero rows written** *(no `rate_limited_total` metric — there's no metrics layer in the codebase yet at all)*
- [x] Tests: breaker state walk (closed→open→half-open→closed and →re-open); rate-limit path writes nothing to Postgres

### Day 4 — Chaos harness

- [x] Receiver chaos modes: `?error_rate=0.3`, `?timeout_rate=0.05`, slow-drip body
- [x] Scenario scripts (each maps to a row of ARCHITECTURE.md §6): kill Redis mid-run; kill worker mid-flight; stall a job past `lockDuration`; force lock expiry during slow HTTP; flush Redis then duplicate POST *("kill worker mid-flight" was already covered by `test/integration/worker-kill.test.ts` from Week 1 Day 5 — not duplicated into test/chaos/)*
- [x] Receiver-side request log assertion helper: "exactly N requests with X-Webhook-Id=…"

### Day 5 — Audit invariants + backpressure

- [x] Invariant suite I1–I5 from SCHEMA.md §1.7 as a Vitest suite, run after every chaos scenario
- [x] Backpressure: cached (1 s) `getJobCounts()`; `wait+delayed > 50000` → 429 + `Retry-After: 5`
- [x] Forced double-processing test → zero second HTTP calls for a DELIVERED delivery
- [ ] 10 consecutive full chaos runs green *(the mechanism exists — `make chaos-loop` + a nightly CI job — but nobody has actually run it 10 times yet; that requires real Docker, which I don't have access to)*
- [ ] **Week 2 exit criteria from PLAN.md all green** *(implemented and reasoned through carefully across all 5 days, but — same as the Week 1 line above — not yet run green end-to-end by anyone. This is the one to verify before calling Week 2 done.)*

---

## Week 3 — Dashboard, Load Test, Polish

### Day 1 — Read API

- [ ] `GET /v1/deliveries`: filters (status CSV, endpoint_id, from/to), keyset pagination on `(updated_at, id)`, limit 50/200
- [ ] `GET /v1/deliveries/:id`: full attempts[] + transitions[] view per API_SPEC.md §3
- [ ] `GET /v1/stats`: Postgres counts (2 s cache) + queue depths (1 s cache)
- [ ] EXPLAIN-check each query against the indexes — no seq scans on the hot paths

### Day 2 — Dashboard

- [ ] Vite + React single page, 2 s polling, dense internal-tool styling (monospace, no auth)
- [ ] Status count header tiles (PENDING / DELIVERING / DELIVERED / FAILED / DLQ) + backpressure indicator
- [ ] Delivery table: status/endpoint/time filters, keyset "load more"
- [ ] Drill-down panel: retry timeline (attempt #, outcome, http_status, latency, body snippet) + transition chain
- [ ] DLQ view with one-click manual retry
- [ ] `dashboard` container: nginx serving build, proxying `/api` → read API

### Day 3 — k6 baseline

- [ ] Ingestion script: ramping-vus 0→2000 over 5 m, hold 10 m, unique Idempotency-Key per iteration, receiver in normal mode
- [ ] Metrics out: ingestion p50/p95/p99, error rate, RPS
- [ ] Delivery lag measured from Postgres (`DELIVERED` transition ts − enqueue ts), not k6
- [ ] Zero-loss check: k6 success count == `events` row count
- [ ] k6 runs outside the compose network's CPU budget (separate machine or pinned CPU shares)

### Day 4 — k6 abuse + saturation

- [ ] Abuse run: receiver at `error_rate=0.3&timeout_rate=0.05` under full load — retry counts within ±5% of analytical expectation; DLQ count matches 0.3⁵ math on forced-permanent endpoints
- [ ] Backpressure run: drive depth past 50k, assert 429s + recovery after load drops
- [ ] Step VUs until ingestion p95 > 500 ms; capture `pgbouncer SHOW POOLS` `maxwait` at the break to confirm (or refute) the pool-wait hypothesis
- [ ] Record the number, the bottleneck evidence, and the knob that would move it

### Day 5 — Report + README

- [ ] `LOADTEST.md`: method, topology, graphs, the saturation number, bottleneck evidence, "what would move it"
- [ ] README: positioning, quickstart (`docker compose up && make demo`), architecture summary linking the four docs
- [ ] ADR section: jittered backoff, append-only audit log, distributed lock vs single worker, outbox vs 2PC, RATE_LIMITED-is-not-an-attempt
- [ ] Receiver obligations doc (API_SPEC.md §6) linked prominently
- [ ] Fresh-clone test on a machine that isn't yours
- [ ] **Week 3 exit criteria from PLAN.md all green**
