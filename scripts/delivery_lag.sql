-- scripts/delivery_lag.sql
--
-- Measures end-to-end delivery latency for the most recent load test run.
--
-- "lag" = time from event ingestion (events.received_at) to the moment the
-- delivery transitioned to DELIVERED (delivery_transitions.created_at where
-- to_status = 'DELIVERED').
--
-- Run after a load test:
--   psql $DATABASE_URL -f scripts/delivery_lag.sql
--
-- Or via make:
--   make loadtest-lag

WITH delivered AS (
  SELECT
    d.id                                       AS delivery_id,
    ev.received_at                             AS ingested_at,
    t.created_at                               AS delivered_at,
    EXTRACT(EPOCH FROM (t.created_at - ev.received_at)) AS lag_s
  FROM deliveries d
  JOIN events             ev ON ev.id = d.event_id
  JOIN delivery_transitions t  ON  t.delivery_id = d.id
                               AND t.to_status   = 'DELIVERED'
  -- Scope to the last 20 minutes so we only see the most recent test run.
  -- Adjust the interval if your test is longer than 20 min.
  WHERE ev.received_at > now() - INTERVAL '2 hours'
)
SELECT
  count(*)                                              AS delivered_count,
  round(min(lag_s)::numeric,   3)                       AS lag_min_s,
  round(avg(lag_s)::numeric,   3)                       AS lag_avg_s,
  round(
    percentile_cont(0.50) WITHIN GROUP (ORDER BY lag_s)::numeric, 3
  )                                                      AS lag_p50_s,
  round(
    percentile_cont(0.95) WITHIN GROUP (ORDER BY lag_s)::numeric, 3
  )                                                      AS lag_p95_s,
  round(
    percentile_cont(0.99) WITHIN GROUP (ORDER BY lag_s)::numeric, 3
  )                                                      AS lag_p99_s,
  round(max(lag_s)::numeric,   3)                       AS lag_max_s
FROM delivered;
