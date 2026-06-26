/**
 * scripts/explain-check.ts
 *
 * Runs EXPLAIN (FORMAT JSON, ANALYZE false) on the four hot query patterns
 * and fails with exit code 1 if any plan node is a Seq Scan on the
 * `deliveries` or `delivery_attempts` tables.
 *
 * Uses SET enable_seqscan = off so the planner is forced to consider
 * indexes even on a small development dataset — the check is about index
 * *existence*, not whether Postgres would actually choose them on a tiny
 * table.
 *
 * Run: npx tsx scripts/explain-check.ts
 * Wire into CI after migration: add it as a post-migrate step.
 */

import pg from 'pg';

const DB_URL = process.env['DATABASE_URL'] ?? process.env['PGBOUNCER_URL'];
if (!DB_URL) {
  console.error('ERROR: DATABASE_URL or PGBOUNCER_URL must be set');
  process.exit(1);
}

const client = new pg.Client({ connectionString: DB_URL });
await client.connect();

// Force the planner to use indexes — we're validating index coverage, not
// selectivity decisions on a small dev dataset.
await client.query('SET enable_seqscan = off');

const HOT_QUERIES: { label: string; sql: string; params: unknown[] }[] = [
  {
    label: 'list deliveries — default (status filter)',
    sql: `SELECT d.id, d.event_id, d.endpoint_id, ev.event_type, d.status,
                 d.attempt_count, d.next_attempt_at, d.created_at, d.updated_at
          FROM deliveries d
          JOIN events ev ON ev.id = d.event_id
          WHERE d.status = ANY($1::text[])
          ORDER BY d.updated_at DESC, d.id DESC
          LIMIT 51`,
    params: [['PENDING', 'DELIVERING', 'DELIVERED', 'FAILED', 'DLQ']],
  },
  {
    label: 'list deliveries — by endpoint_id',
    sql: `SELECT d.id, d.event_id, d.endpoint_id, ev.event_type, d.status,
                 d.attempt_count, d.next_attempt_at, d.created_at, d.updated_at
          FROM deliveries d
          JOIN events ev ON ev.id = d.event_id
          WHERE d.endpoint_id = $1::uuid
          ORDER BY d.updated_at DESC, d.id DESC
          LIMIT 51`,
    params: ['00000000-0000-0000-0000-000000000000'],
  },
  {
    label: 'getDetail — delivery_attempts lookup',
    sql: `SELECT attempt_number, outcome, http_status, response_body, error_message,
                 latency_ms, started_at, finished_at
          FROM delivery_attempts
          WHERE delivery_id = $1::uuid
          ORDER BY attempt_number ASC`,
    params: ['00000000-0000-0000-0000-000000000000'],
  },
  {
    label: 'reconciler claimUnenqueued sweep',
    sql: `SELECT id FROM deliveries
          WHERE enqueued = false
            AND created_at < now() - make_interval(secs => $1)
          FOR UPDATE SKIP LOCKED
          LIMIT 500`,
    params: [60],
  },
];

// Tables where a Seq Scan is considered a hot-path regression
const SEQ_SCAN_ALERT_TABLES = new Set(['deliveries', 'delivery_attempts']);

interface PlanNode {
  'Node Type': string;
  'Relation Name'?: string;
  Plans?: PlanNode[];
}

function findSeqScans(node: PlanNode, found: string[]): void {
  if (node['Node Type'] === 'Seq Scan' && node['Relation Name']) {
    if (SEQ_SCAN_ALERT_TABLES.has(node['Relation Name'])) {
      found.push(node['Relation Name']);
    }
  }
  for (const child of node['Plans'] ?? []) {
    findSeqScans(child, found);
  }
}

let failed = false;

for (const { label, sql, params } of HOT_QUERIES) {
  const result = await client.query<{ 'QUERY PLAN': [{ Plan: PlanNode }] }>(
    `EXPLAIN (FORMAT JSON, ANALYZE false) ${sql}`,
    params,
  );

  const plan = result.rows[0]?.['QUERY PLAN']?.[0]?.Plan;
  if (!plan) {
    console.error(`  SKIP (no plan returned): ${label}`);
    continue;
  }

  const seqScans: string[] = [];
  findSeqScans(plan, seqScans);

  if (seqScans.length > 0) {
    console.error(`  FAIL — Seq Scan on [${seqScans.join(', ')}]: ${label}`);
    failed = true;
  } else {
    console.log(`  OK: ${label}`);
  }
}

await client.end();

if (failed) {
  console.error('\nexplain-check: one or more hot queries will seq-scan — add missing indexes');
  process.exit(1);
} else {
  console.log('\nexplain-check: all hot queries use indexes ✓');
}
