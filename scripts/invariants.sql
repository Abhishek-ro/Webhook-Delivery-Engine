-- Audit invariants (SCHEMA.md §1.7) — ops convenience copy of the exact SQL
-- test/invariants/checks.ts runs. All five must return zero rows; if any
-- one of them doesn't, something upstream of this query is broken, not the
-- query itself.
--
-- Usage:
--   psql "$DATABASE_URL" -f scripts/invariants.sql

-- I1: no delivery DELIVERED twice
SELECT 'I1' AS invariant, delivery_id::text AS offending_id
FROM delivery_transitions
WHERE to_status = 'DELIVERED'
GROUP BY delivery_id
HAVING count(*) > 1;

-- I2: no gaps in attempt numbering
SELECT 'I2' AS invariant, delivery_id::text AS offending_id
FROM delivery_attempts
GROUP BY delivery_id
HAVING max(attempt_number) != count(*);

-- I3: attempt_count matches delivery_attempts reality
SELECT 'I3' AS invariant, d.id::text AS offending_id
FROM deliveries d
LEFT JOIN delivery_attempts a ON a.delivery_id = d.id
GROUP BY d.id, d.attempt_count
HAVING d.attempt_count != count(a.id);

-- I4: no delivery stuck DELIVERING
SELECT 'I4' AS invariant, id::text AS offending_id
FROM deliveries
WHERE status = 'DELIVERING' AND updated_at < now() - interval '5 minutes';

-- I5: terminal DELIVERED has a SUCCESS attempt
SELECT 'I5' AS invariant, d.id::text AS offending_id
FROM deliveries d
WHERE d.status = 'DELIVERED' AND NOT EXISTS (
  SELECT 1 FROM delivery_attempts a
  WHERE a.delivery_id = d.id AND a.outcome = 'SUCCESS'
);
