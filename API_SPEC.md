# API_SPEC.md — HTTP Interface

Base URL: `http://localhost:3000`. JSON everywhere. No auth in v1 (internal tool).
Timestamps are ISO 8601 UTC. IDs are UUIDv4.

**Error envelope** (every non-2xx):

```json
{ "error": { "code": "IDEMPOTENCY_KEY_MISSING", "message": "Idempotency-Key header is required", "details": {} } }
```

**Global status codes**

| Code | Meaning |
|---|---|
| 400 | Validation failure (zod issues in `error.details.issues`) |
| 404 | Resource not found |
| 409 | Legal-state conflict (e.g. retrying a non-DLQ delivery) |
| 413 | Payload > 256 KB |
| 429 | Backpressure (queue depth > 50k) or rate limit — always includes `Retry-After` |
| 503 | Postgres unreachable — **never ack without durability** |

---

## 1. Endpoint Management

### POST /v1/endpoints

```json
// request
{ "client_id": "acme-corp", "url": "https://api.acme.com/webhooks", "signing_secret": "whsec_..." }
```

`signing_secret` optional — generated (`whsec_` + 32 random hex) if omitted.

```json
// 201
{ "id": "e7a1...", "client_id": "acme-corp", "url": "https://api.acme.com/webhooks",
  "signing_secret": "whsec_...", "is_active": true, "created_at": "2026-06-11T10:00:00Z" }
```

The secret is returned **only** on creation and on this internal-tool listing (v1).
400 if `url` is not https (allow http only when `NODE_ENV !== 'production'` — local test receiver).

### GET /v1/endpoints?client_id=acme-corp

`200 { "data": [ <endpoint>, ... ] }` — secrets included in v1 (internal tool, documented tradeoff).

### PATCH /v1/endpoints/:id

```json
// request — only is_active and url are patchable
{ "is_active": false }
```

`200 <endpoint>`. Deactivation stops *new pickups*; in-flight attempts complete. Queued
jobs for an inactive endpoint are requeued with 60s delay (not failed — reactivation resumes them).

---

## 2. Event Ingestion

### POST /v1/events

Headers: `Idempotency-Key: <string ≤ 255 chars>` — **required**, 400 without it.

```json
// request
{ "endpoint_id": "e7a1...", "event_type": "payment.settled",
  "payload": { "payment_id": "pay_123", "amount_cents": 4200, "currency": "INR" } }
```

```json
// 202 — first time. Ack means: committed to Postgres. Not "delivered".
{ "event_id": "9f2b...", "delivery_id": "d41c...", "status": "PENDING", "duplicate": false }
```

```json
// 200 — duplicate Idempotency-Key (Redis fast path OR DB constraint; same response either way)
{ "event_id": "9f2b...", "delivery_id": "d41c...", "status": "DELIVERED", "duplicate": true }
```

| Failure | Response |
|---|---|
| Missing/oversized idempotency key | 400 `IDEMPOTENCY_KEY_MISSING` / `IDEMPOTENCY_KEY_TOO_LONG` |
| Unknown `endpoint_id` | 404 `ENDPOINT_NOT_FOUND` |
| Inactive endpoint | 409 `ENDPOINT_INACTIVE` |
| Payload > 256 KB | 413 `PAYLOAD_TOO_LARGE` |
| Queue depth > 50k | 429 `BACKPRESSURE`, `Retry-After: 5` |
| Postgres down | 503 `STORAGE_UNAVAILABLE` |

---

## 3. Delivery Inspection

### GET /v1/deliveries

Query params: `status` (CSV of PENDING,DELIVERING,DELIVERED,FAILED,DLQ), `endpoint_id`,
`from`/`to` (ISO 8601, filters `created_at`), `limit` (default 50, max 200),
`cursor` (opaque keyset cursor from previous page).

```json
// 200
{ "data": [ { "id": "d41c...", "event_id": "9f2b...", "endpoint_id": "e7a1...",
    "event_type": "payment.settled", "status": "FAILED", "attempt_count": 2,
    "next_attempt_at": "2026-06-11T10:05:12Z", "created_at": "...", "updated_at": "..." } ],
  "next_cursor": "eyJ1cGRhdGVkX2F0IjoiLi4uIiwiaWQiOiIuLi4ifQ==" }
```

Keyset pagination on `(updated_at, id)` — never OFFSET (dies at depth under load).
`next_cursor: null` on the last page.

### GET /v1/deliveries/:id

```json
// 200 — full forensic view
{ "id": "d41c...", "event": { "id": "9f2b...", "event_type": "payment.settled", "payload": { } },
  "endpoint": { "id": "e7a1...", "url": "https://api.acme.com/webhooks" },
  "status": "DELIVERED", "attempt_count": 3,
  "attempts": [
    { "attempt_number": 1, "outcome": "HTTP_ERROR", "http_status": 503, "latency_ms": 187,
      "response_body": "upstream unavailable", "started_at": "...", "finished_at": "..." },
    { "attempt_number": 2, "outcome": "TIMEOUT", "http_status": null, "error_message": "timeout_10s", "latency_ms": 10000, "started_at": "...", "finished_at": "..." },
    { "attempt_number": 3, "outcome": "SUCCESS", "http_status": 200, "latency_ms": 95, "started_at": "...", "finished_at": "..." }
  ],
  "transitions": [
    { "from_status": null, "to_status": "PENDING", "actor": "api", "reason": "created", "created_at": "..." },
    { "from_status": "PENDING", "to_status": "DELIVERING", "actor": "worker", "reason": "attempt_1", "created_at": "..." },
    { "from_status": "DELIVERING", "to_status": "FAILED", "actor": "worker", "reason": "http_503", "created_at": "..." },
    { "from_status": "FAILED", "to_status": "DELIVERING", "actor": "worker", "reason": "attempt_2", "created_at": "..." },
    { "from_status": "DELIVERING", "to_status": "FAILED", "actor": "worker", "reason": "timeout_10s", "created_at": "..." },
    { "from_status": "FAILED", "to_status": "DELIVERING", "actor": "worker", "reason": "attempt_3", "created_at": "..." },
    { "from_status": "DELIVERING", "to_status": "DELIVERED", "actor": "worker", "reason": "http_200", "created_at": "..." }
  ] }
```

---

## 4. Dead Letter Queue

### GET /v1/dlq

Sugar for `GET /v1/deliveries?status=DLQ`, same shape, plus `dlq_entered_at`
(timestamp of the `→ DLQ` transition).

### POST /v1/dlq/:deliveryId/retry

No body.

```json
// 202
{ "delivery_id": "d41c...", "status": "PENDING", "retry_job_id": "d41c...:retry:1781430000000", "attempt_budget": 5 }
```

| Failure | Response |
|---|---|
| Delivery not in DLQ | 409 `NOT_IN_DLQ` (current status in `details`) |
| Unknown delivery | 404 `DELIVERY_NOT_FOUND` |

Semantics: transition `DLQ → PENDING` (`actor='manual-retry'`), enqueue with fresh
jobId (`{deliveryId}:retry:{epochMs}`) — **never** the original jobId (BullMQ would
silently no-op). Attempt numbering continues (6, 7, ...) — the audit trail never resets.

---

## 5. Operations

### GET /v1/stats

```json
// 200
{ "deliveries": { "PENDING": 1240, "DELIVERING": 87, "DELIVERED": 981233, "FAILED": 412, "DLQ": 17 },
  "queues": { "webhook-delivery": { "wait": 1102, "active": 87, "delayed": 530, "failed": 17 },
              "webhook-dlq": { "wait": 17 } },
  "oldest_pending_age_s": 4.2, "backpressure_active": false }
```

Delivery counts from Postgres (cached 2s), queue depths from BullMQ `getJobCounts()` (cached 1s).

### GET /healthz → `200 {"ok":true}` (liveness, no dependency checks)
### GET /readyz → `200` if Postgres + Redis reachable, else `503` with per-dependency status

---

## 6. Outbound Delivery Contract (what receivers get)

```
POST {endpoint.url}
Content-Type: application/json
X-Webhook-Id: d41c...                  ← delivery_id; DEDUPE ON THIS
X-Webhook-Attempt: 3
X-Webhook-Timestamp: 1781430000        ← unix seconds, signed to prevent replay
X-Webhook-Signature: sha256=<hex>
```

```json
{ "event_id": "9f2b...", "event_type": "payment.settled",
  "created_at": "2026-06-11T10:00:00Z", "data": { "payment_id": "pay_123", "amount_cents": 4200, "currency": "INR" } }
```

**Signature:** `hex(HMAC_SHA256(signing_secret, "{X-Webhook-Timestamp}.{raw_body}"))`.
Receivers must verify with constant-time compare and reject timestamps older than 5 minutes.

**Success:** any 2xx within 10 s. Everything else (3xx included — we do not follow
redirects) is a failed attempt and retries on the jittered schedule
10s → 30s → 2m → 10m → 1h, then DLQ.

**Receiver obligations (document in client-facing README):**
- Return 2xx fast; do heavy work async. >10 s = timeout = retry = duplicate.
- Dedupe on `X-Webhook-Id` — at-least-once means duplicates are a *when*, not an *if*.
- Verify the signature; reject stale timestamps.
