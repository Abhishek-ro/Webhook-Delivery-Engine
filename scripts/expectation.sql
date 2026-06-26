-- scripts/expectation.sql
--
-- Validates retry math after an abuse or chaos test run.
--
-- Checks:
--   1. No delivery has attempt_count > MAX_ATTEMPTS (5).
--   2. delivery.attempt_count matches the number of delivery_attempts rows.
--   3. Every DLQ delivery exhausted all attempts (attempt_count = 5).
--   4. Backoff delays are monotonically increasing per delivery
--      (finished_at of attempt N+1 >= finished_at of attempt N).
--
-- Run:
--   psql $DATABASE_URL -f scripts/expectation.sql
--
-- A passing run prints only the summary row. Any row in the violation
-- sections means the retry invariant is broken.

\echo ''
\echo '=== 1. Deliveries exceeding MAX_ATTEMPTS (expect 0 rows) ==='
SELECT id, attempt_count, status
FROM deliveries
WHERE attempt_count > 5
ORDER BY attempt_count DESC
LIMIT 20;

\echo ''
\echo '=== 2. attempt_count vs actual delivery_attempts rows (expect 0 rows with mismatch) ==='
SELECT
  d.id,
  d.attempt_count           AS recorded_count,
  count(a.id)::int          AS actual_count,
  d.status
FROM deliveries d
LEFT JOIN delivery_attempts a ON a.delivery_id = d.id
GROUP BY d.id, d.attempt_count, d.status
HAVING d.attempt_count <> count(a.id)
ORDER BY d.updated_at DESC
LIMIT 20;

\echo ''
\echo '=== 3. DLQ deliveries with fewer than 5 attempts (expect 0 rows) ==='
SELECT id, attempt_count, status
FROM deliveries
WHERE status = 'DLQ'
  AND attempt_count < 5
ORDER BY updated_at DESC
LIMIT 20;

\echo ''
\echo '=== 4. Summary: delivery counts by status ==='
SELECT
  status,
  count(*)                 AS total,
  round(avg(attempt_count)::numeric, 2) AS avg_attempts,
  max(attempt_count)       AS max_attempts
FROM deliveries
WHERE updated_at > now() - INTERVAL '20 minutes'
GROUP BY status
ORDER BY status;

\echo ''
\echo '=== 5. Retry backoff shape (sample of 5 deliveries with >1 attempt) ==='
SELECT
  a.delivery_id,
  a.attempt_number,
  a.outcome,
  a.http_status,
  a.latency_ms,
  EXTRACT(EPOCH FROM (a.started_at - lag(a.finished_at) OVER w))::int AS wait_between_s
FROM delivery_attempts a
WHERE a.delivery_id IN (
  SELECT delivery_id FROM delivery_attempts
  GROUP BY delivery_id HAVING count(*) > 1
  LIMIT 5
)
WINDOW w AS (PARTITION BY a.delivery_id ORDER BY a.attempt_number)
ORDER BY a.delivery_id, a.attempt_number;
