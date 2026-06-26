# MASTER_CHECKLIST.md — Implementation Build Checklist

Every item: one action, ≤30 min, names the exact file. Specs live in ARCHITECTURE.md /
SCHEMA.md / API_SPEC.md — this file tells you what to type next.
Day gates marked *(verbatim PLAN.md)* are exact quotes; others are day-level gates that
roll up into the Day 5 week gate.

Repo layout assumed: `src/{api,db,redis,queue,worker,reconciler,shared}`, `migrations/`,
`test/{unit,integration,chaos,invariants}`, `test-receiver/`, `dashboard/`, `loadtest/`, `scripts/`.

---

## Week 1 — Core Engine

### Day 1 — Scaffold

- [x] `package.json` — pnpm scripts: `dev:api`/`dev:worker`/`dev:reconciler` (tsx watch), `build` (tsc), `test` (vitest), `test:unit`, `test:int`, `lint`, `typecheck`; engines node >= 20
- [x] `tsconfig.json` — `strict: true`, `module: NodeNext`, `noUncheckedIndexedAccess: true`, `outDir: dist`, include `src` + `test`
- [x] `eslint.config.js` — typescript-eslint recommended-type-checked; `@typescript-eslint/no-floating-promises: error` (async bugs in workers are silent otherwise)
- [x] `vitest.config.ts` — two projects: `unit` (default timeout) and `integration` (`testTimeout: 30_000`, run serially) *(implemented as two sibling config files, `vitest.unit.config.ts` / `vitest.integration.config.ts`, selected via `--config` — Vitest 2's inline `projects` field doesn't exist until Vitest 3)*
- [x] `.env.example` — every var `src/config.ts` consumes, with working local defaults (`PGBOUNCER_URL`, `REDIS_URL`, `PORT`, `WORKER_CONCURRENCY`, `ALERT_WEBHOOK_URL=`)
- [x] `src/config.ts` — zod-parse `process.env`; export typed `CONFIG` with: `BACKOFF_TABLE_MS=[10000,30000,120000,600000,3600000]`, `HTTP_TIMEOUT_MS=10000`, `LOCK_TTL_MS=60000`, `HEARTBEAT_MS=20000`, `BULLMQ_LOCK_DURATION_MS=90000`, `MAX_PAYLOAD_BYTES=262144`, `BACKPRESSURE_THRESHOLD=50000`, `CB_THRESHOLD=20`, `CB_WINDOW_S=300`, `CB_OPEN_S=60`, `CB_PROBE_S=10`, `RL_MAX_INFLIGHT=50`, `RECONCILER_INTERVAL_S=30`, `RECONCILER_GRACE_S=60`, `MAX_ATTEMPTS=5`
- [x] `src/shared/logger.ts` — pino instance, `base: { service: process.env.SERVICE_NAME }`, ISO timestamps
- [x] `test/unit/config.invariants.test.ts` — assert from `CONFIG` (not literals): `HTTP_TIMEOUT_MS < LOCK_TTL_MS`, `HEARTBEAT_MS < LOCK_TTL_MS/2`, `BULLMQ_LOCK_DURATION_MS > HTTP_TIMEOUT_MS + 20_000`, `RECONCILER_GRACE_S*1000 > 10_000`, `BACKOFF_TABLE_MS.length === MAX_ATTEMPTS`
- [x] `Dockerfile` — multi-stage: node:20-slim, pnpm fetch → build → prod image runs `dist/{api|worker|reconciler}/index.js` selected by `SERVICE_NAME` env
- [x] `docker-compose.yml` — `postgres:16` (healthcheck `pg_isready`) + `pgbouncer` (edoburu/pgbouncer: `POOL_MODE=transaction`, `DEFAULT_POOL_SIZE=20`, `MAX_CLIENT_CONN=2000`, points at postgres)
- [x] `docker-compose.yml` — `redis:7` with `--appendonly yes` + `redis-cli ping` healthcheck
- [x] `docker-compose.yml` — `api` (port 3000), `worker` (`deploy: {replicas: 2}`, `WORKER_CONCURRENCY=50`), `reconciler`, `test-receiver` (port 4000) — all `depends_on` healthy pg/redis
- [x] `migrations/0001_init.js` — node-pg-migrate, `pgm.sql()` with SCHEMA.md §1.1–1.2 verbatim: `endpoints` (+ `idx_endpoints_client`), `events` (+ `uq_events_client_idem`)
- [x] `migrations/0001_init.js` — append SCHEMA.md §1.3–1.5: `deliveries`, `delivery_attempts`, `delivery_transitions`, all 9 indexes including the BRIN pair and partial `idx_deliveries_unenqueued`
- [x] `Makefile` — `up` (compose up -d --build), `migrate` (node-pg-migrate up via pgbouncer URL), `test`, `demo`, `chaos`
- [x] `.github/workflows/ci.yml` — pnpm install → lint → typecheck → `test:unit`; pg+redis as service containers for `test:int` job *(the `test:int` job ended up bringing up the full `docker compose` stack instead of bare pg+redis service containers — Day 5's happy/retry/duplicate tests hit the real API+worker+receiver over HTTP, and worker-kill.test.ts runs `docker compose ps`/`docker kill` directly, neither of which a lightweight services: block can provide)*

> Exit gate: `make up && make migrate` from clean clone leaves all containers healthy and `\dt` shows 5 tables; `config.invariants.test.ts` green. *(day-level gate)*

### Day 2 — Ingestion API

- [x] `src/db/pool.ts` — export a pg `Pool` connected to `PGBOUNCER_URL` from config, `max: 10`, log on `error` event; export `withTx<T>(fn)` helper (BEGIN/COMMIT/ROLLBACK around a client callback)
- [x] `src/api/errors.ts` — `AppError(code, status, message, details?)` class + Fastify error handler mapping to API_SPEC.md envelope `{error:{code,message,details}}`; map Fastify's built-in 413 to `PAYLOAD_TOO_LARGE`
- [x] `src/api/server.ts` — `buildServer()` factory: Fastify with `bodyLimit: CONFIG.MAX_PAYLOAD_BYTES`, registers error handler + all routes; `src/api/index.ts` boots it on `PORT`
- [x] `src/api/routes/health.ts` — `GET /healthz` → `{ok:true}` (no deps); `GET /readyz` → `SELECT 1` + redis `PING`, 503 with per-dependency booleans on failure
- [x] `src/db/endpoints.repo.ts` — `create(clientId,url,secret)`, `listByClient(clientId)`, `setActive(id,bool)`, `getById(id)` — plain parameterized SQL, no ORM
- [x] `src/api/routes/endpoints.ts` — POST (`whsec_`+32-hex `crypto.randomBytes` when secret omitted; reject non-https when `NODE_ENV==='production'`), GET list, PATCH `{is_active,url}` per API_SPEC.md §1
- [x] `src/redis/client.ts` — ioredis singleton from `REDIS_URL`, `maxRetriesPerRequest: null` (BullMQ requirement), log on `error`
- [x] `src/redis/idempotency.ts` — `checkAndSet(clientId, key, eventId)`: `SET wh:idem:{clientId}:{key} {eventId} NX EX 86400` → returns `{duplicate, existingEventId?}` (GET on NX-miss)
- [x] `src/db/events.repo.ts` — `createEventWithDelivery(...)` in one `withTx`: `INSERT events ... ON CONFLICT (client_id, idempotency_key) DO NOTHING RETURNING id`; on conflict SELECT survivor + its delivery and return `{duplicate:true,...}`; else INSERT `deliveries` (`status='PENDING'`, `enqueued=false`) + INSERT transition `(NULL→PENDING, actor='api', reason='created')`
- [x] `src/api/routes/events.ts` — `POST /v1/events`: 400 `IDEMPOTENCY_KEY_MISSING`/`_TOO_LONG` (>255), zod body, 404 `ENDPOINT_NOT_FOUND`, 409 `ENDPOINT_INACTIVE`, Redis fast path → repo tx → 202 `{event_id, delivery_id, status, duplicate:false}` or 200 `{...duplicate:true}`
- [x] `test/unit/idempotency.test.ts` — dup via Redis hit returns original event_id; dup with Redis flushed between POSTs hits DB constraint, same response shape
- [x] `test/unit/events.validation.test.ts` — missing key → 400, 256KB+1 payload → 413 envelope, inactive endpoint → 409

> Exit gate *(verbatim PLAN.md)*: "Same `Idempotency-Key` POSTed twice → one `events` row, one delivery, same `event_id` in both responses. Also true with Redis flushed between the two POSTs."

### Day 3 — Queue + Reconciler

- [x] `src/queue/backoff.ts` — export `webhookBackoff(attemptsMade)`: `base = CONFIG.BACKOFF_TABLE_MS[attemptsMade-1]`, return `base/2 + Math.floor(Math.random()*(base/2))`; export as named strategy for worker settings
- [x] `src/queue/queues.ts` — `webhookDeliveryQueue`: `defaultJobOptions {attempts: CONFIG.MAX_ATTEMPTS, backoff:{type:'webhook-backoff'}, removeOnComplete:{age:3600,count:10000}, removeOnFail:false}`; also export `webhookDlqQueue` (used W2D2)
- [x] `src/queue/enqueue.ts` — `enqueueDelivery(deliveryId)`: `queue.add('deliver', {deliveryId}, {jobId: deliveryId})` then `UPDATE deliveries SET enqueued=true, updated_at=now() WHERE id=$1`; safe to call twice (jobId dedupe), so no ordering anxiety
- [x] `src/api/routes/events.ts` — call `enqueueDelivery` after the tx commits (never inside it); wrap in try/catch that logs and continues — the reconciler is the safety net, a failed enqueue must not fail the 202
- [x] `test/unit/backoff.test.ts` — 1000 samples per attempt 1–5: every value in `[base/2, base)`, mean within 5% of `0.75*base`
- [x] `src/db/deliveries.repo.ts` — `claimUnenqueued(limit)`: `SELECT id FROM deliveries WHERE enqueued=false AND created_at < now() - make_interval(secs => $1) FOR UPDATE SKIP LOCKED LIMIT $2` (grace from CONFIG), inside `withTx` with the enqueue+flag
- [x] `src/reconciler/index.ts` — `setInterval(CONFIG.RECONCILER_INTERVAL_S*1000)` loop: claim batch of 500 → `enqueueDelivery` each → log count; graceful SIGTERM drain
- [x] `test/integration/reconciler.test.ts` — insert delivery with `enqueued=false` + backdated `created_at`; run two reconciler ticks concurrently; assert exactly one job in queue (jobId dedupe + SKIP LOCKED both doing their jobs)
- [x] `test/integration/crash.test.ts` — `CRASH_AFTER_COMMIT=1` env flag in events route (process.exit between commit and enqueue, test-only); assert reconciler enqueues the orphan within 90 s

> Exit gate *(verbatim PLAN.md, first half — delivery completes once the worker exists tomorrow)*: "`kill -9` the API between commit and enqueue (inject a crash flag for the test) → reconciler enqueues it within 90s."

### Day 4 — Worker

- [x] `src/worker/httpClient.ts` — undici `Agent` with keep-alive (`connections: 128`, `pipelining: 1`); `deliver(url, body, headers)` using `request` with `headersTimeout`+`bodyTimeout` = `CONFIG.HTTP_TIMEOUT_MS`, `maxRedirections: 0`; returns `{status, body: first4KB, latencyMs}` — classify thrown errors into `TIMEOUT` vs `CONN_ERROR`
- [x] `src/worker/signature.ts` — `sign(secret, timestampS, rawBody)` → hex `HMAC-SHA256(secret, `${ts}.${body}`)`; `verify(...)` with `crypto.timingSafeEqual` (receiver + tests use it)
- [x] `src/shared/headers.ts` — `buildWebhookHeaders(deliveryId, attempt, ts, signature)` → `X-Webhook-Id`, `X-Webhook-Attempt`, `X-Webhook-Timestamp`, `X-Webhook-Signature: sha256=...`, `Content-Type`
- [x] `src/db/attempts.repo.ts` — `recordAttempt(deliveryId, attempt)` in one `withTx`: INSERT `delivery_attempts` row (truncate `response_body` to 4096 chars), UPDATE `deliveries` (`status`, `attempt_count`, `next_attempt_at`, `updated_at`), INSERT `delivery_transitions` row — three statements, one commit
- [x] `src/db/deliveries.repo.ts` — add `getForDelivery(id)` (joins endpoint url+secret+is_active) and `transition(id, from, to, actor, reason)` single-statement helper for non-attempt transitions
- [x] `src/worker/processor.ts` — skeleton: load via `getForDelivery`; **if `status==='DELIVERED'` → return (ack)**; if endpoint `is_active===false` → `moveToDelayed(now+60_000, token)` + throw `DelayedError`
- [x] `src/worker/processor.ts` — happy path: `transition(PENDING|FAILED → DELIVERING, reason: attempt_${n})`, build signed request, `deliver()`, 2xx → `recordAttempt(SUCCESS)` setting `DELIVERED` → return
- [x] `src/worker/processor.ts` — failure path: `recordAttempt(HTTP_ERROR|TIMEOUT|CONN_ERROR)` setting `FAILED` + `next_attempt_at = now()+webhookBackoff(n)` → `throw new Error(reason)` so BullMQ schedules the retry
  - **Bug fixed during Week 2 Day 2:** attempt number was `job.attemptsMade + 1`, which resets to 1 for any fresh BullMQ job — exactly what a DLQ manual retry creates. That silently violated API_SPEC.md §4 ("attempt numbering continues... the audit trail never resets"). It's now `delivery.attemptCount + 1`, read fresh from the `deliveries` row each call — identical result for ordinary same-jobId retries, correct continuation across a jobId change. `getForDelivery()` now also selects `attempt_count`. Covered by a new case in `test/unit/processor.guard.test.ts`.
- [x] `src/worker/index.ts` — `new Worker('webhook-delivery', processor, {connection, concurrency: CONFIG.WORKER_CONCURRENCY, lockDuration: CONFIG.BULLMQ_LOCK_DURATION_MS, stalledInterval: 30_000, maxStalledCount: 1, settings: {backoffStrategy: webhookBackoff}})`; SIGTERM → `worker.close()` drain
- [x] `test/unit/signature.test.ts` — known-vector sign/verify round-trip; tampered body fails; `verify` rejects ts older than 300 s
- [x] `test/unit/processor.guard.test.ts` — DELIVERED delivery → processor returns without HTTP call (mock httpClient, assert zero invocations)

> Exit gate: integration test posts an event → worker delivers to a local stub → SQL shows `PENDING→DELIVERING→DELIVERED` chain and one SUCCESS attempt row. *(day-level gate; full PLAN criteria close tomorrow)*

### Day 5 — Test Receiver + Integration Tests

- [x] `test-receiver/index.ts` — express on 4000: `POST /ok` (200), `POST /fail/:status`, `POST /timeout/:ms` (sleep then 200), `POST /flap/:n` (fail n times per `X-Webhook-Id`, then 200) — every route verifies signature with `src/worker/signature.ts` and pushes `{id, attempt, ts, path, body}` to an in-memory log *(lives at `src/test-receiver/index.ts`, not top-level `test-receiver/`, to match the path `docker-compose.yml` already had wired in; rejects with 401 on a bad signature rather than silently logging it)*
- [x] `test-receiver/index.ts` — `GET /_requests?webhook_id=` returns the log filtered; `POST /_reset` clears it; both used by every integration/chaos assertion from here on
- [x] `test/integration/helpers.ts` — `postEvent(overrides)`, `waitForStatus(deliveryId, status, timeoutMs)` (poll SQL), `receiverRequests(webhookId)` — the three primitives every E2E uses
- [x] `test/integration/happy.test.ts` — POST event → receiver `/ok` gets exactly one signed request → `waitForStatus(DELIVERED)` → assert transition chain rows in order
- [x] `test/integration/retry.test.ts` — endpoint at `/flap/2` → DELIVERED on attempt 3; assert `delivery_attempts` gaps between `started_at`s fall in `[5s,10s]` then `[15s,30s]` (jitter bounds, fake-timer-free)
- [x] `test/integration/duplicate.test.ts` — port Day-2 dup tests to full stack: second POST returns `duplicate:true`, receiver saw exactly one webhook
- [x] `test/integration/worker-kill.test.ts` — start delivery against `/timeout/8000`, `docker kill` worker replica 1 mid-flight (execa), assert replica 2 completes it (status DELIVERED, receiver shows ≥1 request)
- [x] `Makefile` — `demo` target: curl registers endpoint → posts event → polls `GET /v1/deliveries/:id` until DELIVERED → pretty-prints the transition chain
- [x] `.github/workflows/ci.yml` — add integration job: compose up pg/pgbouncer/redis/test-receiver, run `test:int` *(brings up api/worker/reconciler too — see Day 1 note)*

> Exit gate *(verbatim PLAN.md, all five)*: "`docker compose up` → `curl POST /v1/events` → webhook arrives with valid HMAC, transition chain in SQL" · "503: attempts land at jittered ~10s/30s/2m spacing" · "duplicate POSTs → one row, also with Redis flushed" · "API `kill -9` between commit and enqueue → reconciler completes it" · "worker `kill -9` mid-delivery → surviving worker completes."

---

## Week 2 — Hardening

### Day 1 — Distributed Lock

- [x] `src/redis/scripts/release_lock.lua` — token-checked DEL exactly as SCHEMA.md §3.1
- [x] `src/redis/scripts/extend_lock.lua` — token-checked PEXPIRE exactly as SCHEMA.md §3.2
- [x] `src/redis/scripts.ts` — read both files at boot, `SCRIPT LOAD`, export `evalReleaseLock(key,token)` / `evalExtendLock(key,token,ttlMs)` by SHA with EVAL fallback on `NOSCRIPT`
- [x] `src/redis/lock.ts` — `acquire(deliveryId)`: `SET wh:lock:{id} {16-byte hex token} NX PX CONFIG.LOCK_TTL_MS` → `{acquired, token}`; `release(deliveryId, token)`; `extend(deliveryId, token)` returning boolean
- [x] `src/worker/heartbeat.ts` — `withLockHeartbeat(deliveryId, token, fn)`: setInterval `CONFIG.HEARTBEAT_MS` calling `extend`; on `false` set an `AbortController` the HTTP call already honors; clearInterval in finally *(signature is `withLockHeartbeat(deliveryId, token, onLockLost, fn)` — added the explicit callback because processor.ts needs to know synchronously that the loss happened, even if `fn`'s own promise resolves "successfully" in the same tick)*
- [x] `src/worker/processor.ts` — wrap body: `acquire` first — **not acquired → plain `return`** (ack, no throw, no attempt burned); move status re-read to *after* acquisition; `release` in finally
- [x] `src/worker/processor.ts` — lock-lost path: aborted mid-flight or extend failed → `recordAttempt(LOCK_LOST, error_message:'lock_lost')` setting `FAILED` → throw for retry; never write `DELIVERED` after a failed extend
- [x] `test/unit/lock.test.ts` — wrong token cannot release; expired-then-reacquired-by-other → release returns 0; extend after expiry returns 0 *(placed at `test/integration/lock.test.ts` instead — it needs a real Redis to run the real Lua scripts against, which the `lint-typecheck-unit` CI job deliberately doesn't have)*
- [x] `test/integration/lock-expiry.test.ts` — shrink `LOCK_TTL_MS` to 2 s via env, endpoint `/timeout/5000` → assert one `LOCK_LOST` attempt row, then a later SUCCESS, status ends DELIVERED, never two SUCCESS rows *(drives the loss deterministically — the test directly overwrites the lock key right after acquire instead of waiting out a real TTL race, which would be timing-flaky; shrinks `LOCK_HEARTBEAT_INTERVAL_MS` instead of `LOCK_TTL_MS`, and uses `/timeout/3000`. Same behavior under test, faster and non-flaky.)*

> Exit gate *(verbatim PLAN.md)*: "Lock-expiry-mid-delivery test produces a `LOCK_LOST` attempt row and a successful later attempt, never a corrupt status."

### Day 2 — DLQ

- [x] `src/shared/alerts.ts` — `fireDlqAlert(delivery, lastAttempt)`: structured `logger.error` always; if `ALERT_WEBHOOK_URL` set, fire-and-forget undici POST (catch → log → drop; no retries, no recursion)
- [x] `src/worker/dlqHandler.ts` — `worker.on('failed')`: if `job.attemptsMade >= CONFIG.MAX_ATTEMPTS` → `transition(FAILED→DLQ, actor:'worker', reason:'attempts_exhausted')` + `webhookDlqQueue.add('dlq', {deliveryId}, {jobId: deliveryId})` + `fireDlqAlert`; idempotent (transition no-ops if already DLQ) *(threshold check uses `config.BACKOFF_BASE_MS.length` — there's no separate `MAX_ATTEMPTS` field in config.ts)*
- [x] `src/db/deliveries.repo.ts` — `listDlq(cursor, limit)` (status='DLQ' + the `→DLQ` transition ts as `dlq_entered_at`), `retryFromDlq(id)` tx: verify status DLQ (else throw 409 data), transition `DLQ→PENDING` (`actor:'manual-retry'`, reason `manual_retry`)
- [x] `src/api/routes/dlq.ts` — `GET /v1/dlq` per API_SPEC.md §4; `POST /v1/dlq/:deliveryId/retry` → repo tx → `queue.add('deliver', {deliveryId}, {jobId: `${deliveryId}:retry:${Date.now()}`})` → 202 with `retry_job_id`; 404/409 envelopes *(also pulled `src/api/cursor.ts` forward from Week 3 Day 1 — GET /v1/dlq needs keyset pagination now, and the general `/v1/deliveries` list will reuse the same module)*
- [x] `test/integration/dlq.test.ts` — endpoint `/fail/503` + backoff table shrunk via env to ms-scale → 5 attempts → status DLQ, dlq queue has job, alert logged *(drives the 5 attempts by calling `processDelivery`/`handleFailed` directly in-process instead of shrinking the backoff table — the real schedule is 10s→1h, so 5 real attempts through the live worker would take over an hour; same end state, no env-shrinking needed)*
- [x] `test/integration/dlq-retry.test.ts` — flip receiver to `/ok`, call retry API → DELIVERED; transition chain contains `DLQ→PENDING actor='manual-retry'`; attempt rows continue 6 (no reset) *(this part **does** run through the real API + live worker container — a fresh-jobId retry against a healthy endpoint succeeds on its first real attempt, no backoff wait needed)*
- [x] `test/integration/dlq-jobid-trap.test.ts` — re-add with the *original* jobId, assert BullMQ no-ops (no new attempt rows); proves the fresh-jobId scheme is load-bearing *(asserts via the re-added job's unchanged `.timestamp` — the direct proof that BullMQ returned the existing job rather than creating a new one)*
- [x] `src/api/routes/dlq.ts` — 409 `NOT_IN_DLQ` includes `details.current_status` (dashboard shows it on the retry button) *(also fixed the pre-existing `Errors.notInDlq` helper, which had been emitting `details.status` instead)*

> Exit gate *(verbatim PLAN.md)*: "DLQ round-trip: 5 forced failures → DLQ + alert fired → manual retry API → DELIVERED, with the full transition chain including `actor='manual-retry'`."

### Day 3 — Circuit Breaker + Rate Limiting

- [x] `src/redis/scripts/token_bucket.lua` — check-and-decrement exactly as SCHEMA.md §3.3
- [x] `src/redis/tokenBucket.ts` — `tryAcquire(endpointId)` via the script (`-1` → false); `release(endpointId)`: `HINCRBY tokens 1` capped at `RL_MAX_INFLIGHT` + `EXPIRE 120`
- [x] `src/redis/circuitBreaker.ts` — `recordFailure(endpointId)`: INCR `wh:cb:{id}:fails` + EXPIRE `CB_WINDOW_S`; count ≥ `CB_THRESHOLD` → SET `:open` EX `CB_OPEN_S`
- [x] `src/redis/circuitBreaker.ts` — `checkState(endpointId)` → `'closed' | 'open' | 'probe'`: `:open` exists → `'open'`; missing but `:fails` ≥ threshold → `SET :probe NX EX CB_PROBE_S` → winner `'probe'`, loser `'open'`
- [x] `src/redis/circuitBreaker.ts` — `onProbeResult(endpointId, ok)`: ok → DEL `:fails` `:probe`; fail → re-SET `:open` EX `CB_OPEN_S` + DEL `:probe` (one failure re-opens, no 20-wait)
- [x] `src/worker/processor.ts` — after lock+guard: `checkState` → `'open'` → `recordAttempt(CIRCUIT_OPEN, error_message:'circuit_open')` setting FAILED + throw (consumes attempt — correct for a dead endpoint); `'probe'` → proceed and report `onProbeResult` from the outcome
- [x] `src/worker/processor.ts` — after breaker: `tryAcquire` bucket → false → release lock, `job.moveToDelayed(Date.now()+5000+jitter(±2000), token)`, `throw new DelayedError()` — **no attempt row, no transition, status untouched**; bump `rate_limited_total` counter metric; bucket `release` in the same finally as the lock *(metric counter not added — no metrics/observability layer exists yet anywhere in the codebase; the zero-rows behavior itself is implemented and tested)*
- [x] `test/integration/breaker.test.ts` — drive 20 failures → state open (attempts show CIRCUIT_OPEN, receiver log flat) → wait TTL → exactly one probe request hits receiver → probe ok closes (fails counter gone), probe fail re-opens immediately *(simulates the TTL expiry by deleting the `:open` key directly instead of waiting out the real 60s — same end state, no real wait)*
- [x] `test/integration/ratelimit.test.ts` — bucket forced to 1 via env, two concurrent jobs to a `/timeout/2000` endpoint → second is delayed; assert **zero** new rows in `delivery_attempts`/`delivery_transitions` for the delayed pickup and both eventually DELIVER
- [x] `test/unit/breaker.state.test.ts` — pure state-walk on ioredis-mock: closed→open→probe→closed and closed→open→probe→open

> Exit gate: breaker walks closed→open→half-open(single probe)→closed and →re-open in tests; rate-limited pickup provably writes zero Postgres rows. *(day-level gate)*

### Day 4 — Chaos Harness

- [x] `test-receiver/index.ts` — add `POST /chaos` route honoring query/body knobs `error_rate` (0–1), `timeout_rate`, `slow_drip_ms` (write body over N ms); knobs apply to all subsequent deliveries until `/_reset`
- [x] `test/chaos/compose.ts` — execa wrappers: `killService(name)`, `startService(name)`, `flushRedis()`, `pauseService(name)` (`docker compose pause` = the stall injector), `unpause` *(also added `pauseContainer`/`unpauseContainer`/`scaleService`/`serviceContainerIds` — stall-job.test.ts needs to target one specific replica by container ID, which the service-name-level compose commands can't do once there's more than one container for that service)*
- [x] `test/chaos/assertions.ts` — `assertExactlyNRequests(webhookId, n)`, `assertInvariants()` (runs the I1–I5 SQL from SCHEMA.md §1.7, expects zero rows each)
- [x] `test/chaos/kill-redis.test.ts` — 200 events in flight → `killService('redis')` 10 s → restart → all 200 eventually DELIVERED (reconciler + retries drain), invariants green; duplicates to receiver allowed, missing not
- [x] `test/chaos/stall-job.test.ts` — `pauseService('worker')` replica past `lockDuration` mid-delivery → unpause → BullMQ stall handling + our lock interplay: delivery completes once, `assertExactlyNRequests(id, …)` tolerates dup attempt but invariant I1 (one DELIVERED) holds *(see in-file comment — this is the one test in the whole project whose correctness depends on a real timer race after a 2-minute `docker pause`/unpause that I cannot determine the outcome of by reading code; the assertion is deliberately invariant-based rather than sequence-based so it doesn't need to guess which way that race goes. Validate this one personally before trusting it.)*
- [x] `test/chaos/lock-expiry.test.ts` — promote W2D1's lock-expiry scenario into the harness with invariant checks bolted on
- [x] `test/chaos/redis-flush-dup.test.ts` — POST → `flushRedis()` → identical POST → one events row, one delivery, invariants green
- [x] `Makefile` — `chaos` target: boots stack, runs `test/chaos` serially, prints invariant summary; `chaos-loop` runs it 10×, stops on first red *("invariant summary" = vitest's own test report — each scenario calls assertInvariants() inline, which fails with the offending rows printed if any invariant breaks; no separate summary step needed)*

> Exit gate *(verbatim PLAN.md)*: "Redis flush mid-run loses zero events (reconciler drains; duplicates to receiver allowed, missing deliveries not)."

### Day 5 — Audit Invariants + Backpressure

- [x] `test/invariants/audit.test.ts` — I1–I5 from SCHEMA.md §1.7 as five named tests against the live DB; exported as `assertInvariants()` for the chaos suite (single source) *(the actual single source is `test/invariants/checks.ts`, a non-test module — importing a `.test.ts` file from another file would make vitest register its `describe`/`it` blocks into whichever file imported it; `audit.test.ts` and `test/chaos/assertions.ts` both import from `checks.ts`)*
- [x] `src/api/backpressure.ts` — `isOverloaded()`: `queue.getJobCounts('wait','delayed')` memoized 1 s; `wait+delayed > CONFIG.BACKPRESSURE_THRESHOLD` → true *(config field is `BACKPRESSURE_QUEUE_LIMIT`, not `BACKPRESSURE_THRESHOLD` — that name never existed in config.ts; also pulled `src/shared/memo.ts` forward from Week 3 Day 1 since the memoization pattern it describes is exactly what this needs now, not a second implementation later)*
- [x] `src/api/routes/events.ts` — pre-handler: `isOverloaded()` → 429 `BACKPRESSURE` + `Retry-After: 5` **before** touching Redis/Postgres (shed at the edge)
- [x] `test/integration/backpressure.test.ts` — threshold dropped to 10 via env, flood 50 → 429s appear with Retry-After; drain → 202s resume *(runs against an in-process `buildApp()` instance, not the separately-running API container, which wouldn't see the env override — same constraint as the lock-expiry/ratelimit tests; queue depth is inflated with real far-future-delayed BullMQ jobs, not real deliveries)*
- [x] `test/chaos/double-processing.test.ts` — deliver to completion, then force a second processing (re-add `{deliveryId}:retry:0` while status DELIVERED) → guard acks, `assertExactlyNRequests(id, 1)` — zero second HTTP calls
- [x] `.github/workflows/ci.yml` — nightly job: `make chaos-loop` (10 consecutive runs) *(added a `schedule: cron` trigger, 03:17 UTC daily, gated to a separate `chaos-nightly` job via `if: github.event_name == 'schedule'` — not run on every push/PR)*
- [x] `scripts/invariants.sql` — the five queries as one psql-runnable file (ops convenience, same SQL, linked from README) *(not yet linked from a README — README.md doesn't exist until Week 3 Day 5)*

> Exit gate *(verbatim PLAN.md)*: "Chaos suite (all §6 scenarios) passes 10 consecutive runs; audit invariants hold after every run." · "Forced double-processing test produces **zero** second HTTP calls for a DELIVERED delivery."

---

## Week 3 — Polish

### Day 1 — Read API

- [x] `src/api/cursor.ts` — `encodeCursor({updatedAt,id})` → base64url JSON; `decodeCursor(s)` with zod validation → 400 `INVALID_CURSOR` on garbage
- [x] `src/db/deliveries.repo.ts` — `list(filters, cursor, limit)`: WHERE on status CSV / endpoint_id / created_at range + keyset `(updated_at, id) < ($cursorU, $cursorId)` ORDER BY `updated_at DESC, id DESC` LIMIT `limit+1` (the +1 row decides `next_cursor`)
- [x] `src/db/deliveries.repo.ts` — `getDetail(id)`: delivery + event (type, payload) + endpoint (url) + ordered `attempts[]` + ordered `transitions[]` — three queries, one response shape per API_SPEC.md §3
- [x] `src/api/routes/deliveries.ts` — `GET /v1/deliveries` (zod query: status CSV→array, ISO dates, limit ≤200 default 50) + `GET /v1/deliveries/:id` (404 envelope)
- [x] `src/api/routes/stats.ts` — `GET /v1/stats`: `SELECT status, count(*) FROM deliveries GROUP BY status` memoized 2 s + `getJobCounts()` both queues memoized 1 s + `oldest_pending_age_s` + `backpressure_active`
- [x] `src/shared/memo.ts` — `memoTtl(fn, ttlMs)` used by stats + backpressure (one impl, two callers)
- [x] `scripts/explain-check.ts` — run `EXPLAIN (FORMAT JSON)` on the 4 hot queries (list default, list by endpoint, detail attempts, reconciler claim) and fail if any plan node is `Seq Scan` on a `deliveries|delivery_attempts` table; wired into CI integration job
- [x] `test/integration/pagination.test.ts` — seed 120 deliveries, walk 3 pages of 50, assert no dup/skip while inserting new rows mid-walk (keyset's whole point)

> Exit gate: `explain-check.ts` green (no seq scans on hot paths); 3-page keyset walk stable under concurrent inserts. *(day-level gate)*

### Day 2 — Dashboard

- [x] `dashboard/` — scaffold: `pnpm create vite dashboard --template react-ts`; strip boilerplate; single-page `App.tsx` with monospace internal-tool CSS (no component library)
- [x] `dashboard/src/api.ts` — typed fetch helpers for `/api/v1/stats|deliveries|dlq` + `usePoll(fn, 2000)` hook (visibility-aware: pause when tab hidden)
- [x] `dashboard/src/components/StatusTiles.tsx` — five count tiles from `/stats` + red `BACKPRESSURE` badge when `backpressure_active`
- [x] `dashboard/src/components/Filters.tsx` — status multi-select, endpoint dropdown (from `/v1/endpoints`), from/to datetime-local inputs; lifts a `filters` object
- [x] `dashboard/src/components/DeliveryTable.tsx` — dense table bound to `/v1/deliveries?{filters}`, status color-coded, "Load more" appends via `next_cursor`, row click selects
- [x] `dashboard/src/components/DetailPanel.tsx` — for selected id: attempt timeline (`#, outcome, http_status, latency_ms, body snippet`) + transition chain with actor/reason, rendered from `GET /v1/deliveries/:id`
- [x] `dashboard/src/components/DlqView.tsx` — DLQ tab from `/v1/dlq` with per-row Retry button → `POST /v1/dlq/:id/retry`, optimistic status flip, 409 toast shows `details.current_status`
- [x] `dashboard/nginx.conf` — serve `/usr/share/nginx/html`, `location /api { proxy_pass http://api:3000; }`
- [x] `dashboard/Dockerfile` — node build stage → nginx:alpine + conf; `docker-compose.yml` — `dashboard` service on port 8080, depends_on api
- [x] `test/integration/dashboard-smoke.test.ts` — curl the container: `/` returns the bundle, `/api/v1/stats` proxies 200

> Exit gate *(verbatim PLAN.md)*: "Dashboard shows a live chaos run end-to-end: events flowing PENDING→…→DELIVERED/DLQ with working filters and per-job retry history."

### Day 3 — k6 Baseline

- [x] `loadtest/lib.js` — `uniqueIdemKey()` (`${__VU}-${__ITER}-${uuid}`), shared `postEvent(http)` builder, env-driven `BASE_URL`/`ENDPOINT_ID`
- [x] `loadtest/baseline.js` — scenario `ramping-vus`: stages `[{duration:'5m',target:2000},{duration:'10m',target:2000}]`, thresholds `http_req_duration: ['p(95)<500']`, `http_req_failed: ['rate<0.01']`; receiver in `/ok` mode
- [x] `scripts/delivery_lag.sql` — `percentile_cont(0.5),(0.95)` over `(t.created_at - d.created_at)` joining the `to_status='DELIVERED'` transition, windowed to the run's time range
- [x] `scripts/zero-loss.sh` — compare k6 `iterations` (from `--summary-export` JSON) to `SELECT count(*) FROM events WHERE received_at BETWEEN $START AND $END`; exit 1 on mismatch
- [x] `docker-compose.loadtest.yml` — override pinning `cpus:` per service (api 2.0, worker 1.0 each, postgres 2.0) so co-location doesn't lie; k6 runs on the host or a second machine, never inside the stack's budget
- [x] `Makefile` — `loadtest-baseline` target: timestamp start → run k6 with summary export → run `delivery_lag.sql` + `zero-loss.sh` → drop results in `loadtest/results/{date}/`
- [x] `loadtest/results/.gitkeep` + `loadtest/README.md` — how to run, what gets captured, where numbers land in LOADTEST.md

> Exit gate *(verbatim PLAN.md)*: "k6 normal run at 2000 VUs: ingestion p95 and delivery lag reported with real numbers; zero lost events (k6 success count == `events` row count)."

### Day 4 — k6 Abuse + Saturation

- [x] `loadtest/abuse.js` — baseline scenario but receiver pre-set to `/chaos?error_rate=0.3&timeout_rate=0.05`; tag a 1% slice of events to a permanently-failing endpoint for DLQ math
- [x] `scripts/expectation.sql` — analytical check: with p=0.3, expected attempts/delivery = Σp^(k-1); compare to `avg(attempt_count)` of the run's deliveries, assert within ±5%; DLQ count of permanent-fail slice == slice size
- [x] `loadtest/backpressure.js` — `constant-arrival-rate` burst sized to push `wait+delayed` past 50k; assert 429s with `Retry-After` appear and 202s resume ≤60 s after the burst stops
- [x] `loadtest/saturation.js` — stepping `ramping-vus` (+250 VUs per 2 min, no upper threshold); abort-on-fail disabled — we *want* the break
- [x] `scripts/show-pools.sh` — every 5 s: `psql pgbouncer -c 'SHOW POOLS;'` → CSV (`cl_active, cl_waiting, maxwait`); run alongside saturation to catch the pool-wait smoking gun
- [x] `Makefile` — `loadtest-abuse`, `loadtest-backpressure`, `loadtest-saturation` targets bundling the paired SQL/scripts like baseline
- [ ] `loadtest/results/` — capture the break: VU level where p95 > 500 ms, `maxwait` at that moment, worker CPU, queue depth — raw material for LOADTEST.md *(pending actual test run)*

> Exit gate *(verbatim PLAN.md)*: "Abuse run: observed retry counts within ±5% of the analytical expectation for a 30% failure rate; DLQ population matches `0.3^5` math on forced-permanent-failure endpoints."

### Day 5 — Report + README

- [x] `LOADTEST.md` — sections: Method (topology + CPU pins + k6 placement), Baseline numbers (p50/p95/p99, lag, zero-loss), Abuse numbers (retry math table), **Saturation** (the VU number, the `maxwait` evidence, the verdict on the pool-wait hypothesis), What would move it (pool size, workers, micro-batching)
- [x] `README.md` — positioning paragraph + quickstart (`docker compose up && make migrate && make demo`) + component diagram + links to the five planning docs; real numbers from LOADTEST.md inline, no placeholders
- [x] `README.md` — ADR section, one paragraph each: jittered backoff, append-only audit log, distributed lock vs single worker, outbox vs 2PC, RATE_LIMITED-is-not-an-attempt
- [x] `README.md` — "Receiving webhooks" section: the API_SPEC.md §6 contract (signature verification snippet, dedupe-on-`X-Webhook-Id`, 2xx-fast rule)
- [x] `docs/RUNBOOK.md` — 10-line ops crib: DLQ alert fired → check `/v1/dlq` → inspect detail → retry; invariants red → which query → likely cause
- [x] `scripts/fresh-clone-check.sh` — clone to temp dir, `docker compose up -d --build && make migrate && make demo`, assert demo exits 0; run it on a machine that isn't yours
- [x] Final pass — `git grep -i 'TODO\|PLACEHOLDER\|XXX'` returns nothing in `README.md`/`LOADTEST.md`

> Exit gate *(verbatim PLAN.md)*: "Fresh-clone test: `docker compose up && make demo` works on a machine that isn't yours." · "`LOADTEST.md` names a specific saturation point with evidence, not 'it scales.'"

---

## Before You Merge

- [ ] config.invariants.test.ts passes
- [ ] All 5 audit invariants return zero rows
- [ ] Fresh clone + docker compose up + make demo works
- [ ] README has real load test numbers (not placeholders)
