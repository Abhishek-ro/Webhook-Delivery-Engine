import { pool, withTx } from './pool.js';
import { webhookDeliveryQueue } from '../queue/queues.js';
import { config } from '../shared/config.js';

// ---------------------------------------------------------------------------
// List deliveries (Week 3 Day 1 - Read API)
// ---------------------------------------------------------------------------

export interface DeliveryListRow {
  id: string;
  event_id: string;
  endpoint_id: string;
  event_type: string;
  status: string;
  attempt_count: number;
  next_attempt_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface DeliveryListFilters {
  statuses?: string[];
  endpointId?: string;
  from?: Date;
  to?: Date;
}

export async function list(
  filters: DeliveryListFilters,
  cursor: { updatedAt: string; id: string } | null,
  limit: number,
): Promise<{ rows: DeliveryListRow[]; hasMore: boolean }> {
  const params: unknown[] = [];
  const conditions: string[] = [];

  if (filters.statuses && filters.statuses.length > 0) {
    params.push(filters.statuses);
    conditions.push('d.status = ANY($' + String(params.length) + '::text[])');
  }

  if (filters.endpointId) {
    params.push(filters.endpointId);
    conditions.push('d.endpoint_id = $' + String(params.length) + '::uuid');
  }

  if (filters.from) {
    params.push(filters.from.toISOString());
    conditions.push('d.created_at >= $' + String(params.length) + '::timestamptz');
  }

  if (filters.to) {
    params.push(filters.to.toISOString());
    conditions.push('d.created_at <= $' + String(params.length) + '::timestamptz');
  }

  if (cursor) {
    params.push(cursor.updatedAt, cursor.id);
    const p1 = String(params.length - 1);
    const p2 = String(params.length);
    conditions.push(
      '(d.updated_at, d.id::text) < ($' + p1 + '::timestamptz, $' + p2 + '::text)',
    );
  }

  const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
  params.push(limit + 1);
  const limitParam = '$' + String(params.length);

  const result = await pool.query<DeliveryListRow>(
    'SELECT d.id, d.event_id, d.endpoint_id, ev.event_type, d.status,' +
    ' d.attempt_count, d.next_attempt_at, d.created_at, d.updated_at' +
    ' FROM deliveries d' +
    ' JOIN events ev ON ev.id = d.event_id' +
    ' ' + where +
    ' ORDER BY d.updated_at DESC, d.id DESC' +
    ' LIMIT ' + limitParam,
    params,
  );

  const hasMore = result.rows.length > limit;
  return { rows: result.rows.slice(0, limit), hasMore };
}

// ---------------------------------------------------------------------------
// Single delivery detail (Week 3 Day 1 - Read API)
// ---------------------------------------------------------------------------

export interface AttemptDetail {
  attempt_number: number;
  outcome: string;
  http_status: number | null;
  response_body: string | null;
  error_message: string | null;
  latency_ms: number;
  started_at: Date;
  finished_at: Date;
}

export interface TransitionDetail {
  from_status: string | null;
  to_status: string;
  actor: string;
  reason: string | null;
  created_at: Date;
}

export interface DeliveryDetail {
  id: string;
  status: string;
  attempt_count: number;
  next_attempt_at: Date | null;
  created_at: Date;
  updated_at: Date;
  event: { id: string; event_type: string; payload: unknown; received_at: Date };
  endpoint: { id: string; url: string };
  attempts: AttemptDetail[];
  transitions: TransitionDetail[];
}

export async function getDetail(id: string): Promise<DeliveryDetail | null> {
  const deliveryResult = await pool.query<{
    id: string;
    status: string;
    attempt_count: number;
    next_attempt_at: Date | null;
    created_at: Date;
    updated_at: Date;
    event_id: string;
    event_type: string;
    payload: unknown;
    received_at: Date;
    endpoint_id: string;
    endpoint_url: string;
  }>(
    'SELECT d.id, d.status, d.attempt_count, d.next_attempt_at, d.created_at, d.updated_at,' +
    ' ev.id AS event_id, ev.event_type, ev.payload, ev.received_at,' +
    ' e.id AS endpoint_id, e.url AS endpoint_url' +
    ' FROM deliveries d' +
    ' JOIN events ev ON ev.id = d.event_id' +
    ' JOIN endpoints e ON e.id = d.endpoint_id' +
    ' WHERE d.id = $1',
    [id],
  );

  const row = deliveryResult.rows[0];
  if (!row) return null;

  const [attemptsResult, transitionsResult] = await Promise.all([
    pool.query<AttemptDetail>(
      'SELECT attempt_number, outcome, http_status, response_body, error_message,' +
      ' latency_ms, started_at, finished_at' +
      ' FROM delivery_attempts WHERE delivery_id = $1 ORDER BY attempt_number ASC',
      [id],
    ),
    pool.query<TransitionDetail>(
      'SELECT from_status, to_status, actor, reason, created_at' +
      ' FROM delivery_transitions WHERE delivery_id = $1 ORDER BY id ASC',
      [id],
    ),
  ]);

  return {
    id: row.id,
    status: row.status,
    attempt_count: row.attempt_count,
    next_attempt_at: row.next_attempt_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    event: {
      id: row.event_id,
      event_type: row.event_type,
      payload: row.payload,
      received_at: row.received_at,
    },
    endpoint: { id: row.endpoint_id, url: row.endpoint_url },
    attempts: attemptsResult.rows,
    transitions: transitionsResult.rows,
  };
}

// ---------------------------------------------------------------------------
// Worker read path (Week 1 Day 4)
// ---------------------------------------------------------------------------

export interface DeliveryForWorker {
  id: string;
  status: string;
  attemptCount: number;
  endpointId: string;
  endpointUrl: string;
  signingSecret: string;
  endpointActive: boolean;
  eventId: string;
  eventType: string;
  payload: unknown;
  receivedAt: Date;
}

interface DeliveryForWorkerRow {
  id: string;
  status: string;
  attempt_count: number;
  endpoint_id: string;
  endpoint_url: string;
  signing_secret: string;
  endpoint_active: boolean;
  event_id: string;
  event_type: string;
  payload: unknown;
  received_at: Date;
}

export async function getForDelivery(id: string): Promise<DeliveryForWorker | null> {
  const result = await pool.query<DeliveryForWorkerRow>(
    `SELECT d.id, d.status, d.attempt_count,
            e.id AS endpoint_id, e.url AS endpoint_url, e.signing_secret, e.is_active AS endpoint_active,
            ev.id AS event_id, ev.event_type, ev.payload, ev.received_at
     FROM deliveries d
     JOIN endpoints e ON e.id = d.endpoint_id
     JOIN events ev ON ev.id = d.event_id
     WHERE d.id = $1`,
    [id],
  );

  const row = result.rows[0];
  if (!row) return null;

  return {
    id: row.id,
    status: row.status,
    attemptCount: row.attempt_count,
    endpointId: row.endpoint_id,
    endpointUrl: row.endpoint_url,
    signingSecret: row.signing_secret,
    endpointActive: row.endpoint_active,
    eventId: row.event_id,
    eventType: row.event_type,
    payload: row.payload,
    receivedAt: row.received_at,
  };
}

export async function transition(
  deliveryId: string,
  fromStatus: string,
  toStatus: string,
  actor: string,
  reason: string,
): Promise<void> {
  await withTx(async (client) => {
    await client.query(
      `UPDATE deliveries SET status = $2, updated_at = now() WHERE id = $1`,
      [deliveryId, toStatus],
    );
    await client.query(
      `INSERT INTO delivery_transitions (delivery_id, from_status, to_status, reason, actor)
       VALUES ($1, $2, $3, $4, $5)`,
      [deliveryId, fromStatus, toStatus, reason, actor],
    );
  });
}

export async function claimUnenqueued(limit: number): Promise<number> {
  return withTx(async (client) => {
    // Three cases where a delivery needs reconciler recovery:
    //
    // 1. PENDING, enqueued = false: enqueueDelivery() threw before the BullMQ
    //    add() succeeded (e.g. Redis was down at ingest time). Classic case.
    //
    // 2. PENDING, enqueued = true: enqueueDelivery() *did* add the job to
    //    BullMQ and committed enqueued=true, but then Redis was killed -- the
    //    job is gone and the old WHERE enqueued=false filter would never see
    //    this delivery again. Re-adding with the same jobId is idempotent
    //    (BullMQ deduplicates on jobId), so this is safe.
    //
    // 3. FAILED with an overdue next_attempt_at: BullMQ had a delayed-retry
    //    job scheduled, but a Redis restart wiped it. The delivery sits in
    //    FAILED with no worker coming for it. Re-enqueueing immediately is
    //    acceptable -- the reconciler's RECONCILER_GRACE_SECONDS grace period
    //    is already longer than the first backoff step, so we are not
    //    short-circuiting meaningful wait time.
    //
    // DELIVERING is intentionally excluded: a worker actively holds the lock
    // during that state, and touching it here would race.
    const result = await client.query<{ id: string }>(
      `SELECT id FROM deliveries
       WHERE (
         status = 'PENDING'
         OR (
           status = 'FAILED'
           AND next_attempt_at IS NOT NULL
           AND next_attempt_at < now()
         )
       )
       AND updated_at < now() - make_interval(secs => $1)
       FOR UPDATE SKIP LOCKED
       LIMIT $2`,
      [config.RECONCILER_GRACE_SECONDS, limit],
    );

    for (const { id } of result.rows) {
      await webhookDeliveryQueue.add('deliver', { deliveryId: id }, { jobId: id });
      await client.query(
        `UPDATE deliveries SET enqueued = true, updated_at = now() WHERE id = $1`,
        [id],
      );
    }

    return result.rows.length;
  });
}

// ---------------------------------------------------------------------------
// DLQ (Week 2 Day 2)
// ---------------------------------------------------------------------------

export interface DlqRow {
  id: string;
  event_id: string;
  endpoint_id: string;
  event_type: string;
  status: string;
  attempt_count: number;
  next_attempt_at: Date | null;
  created_at: Date;
  updated_at: Date;
  dlq_entered_at: Date;
}

export interface DlqCursor {
  updatedAt: Date;
  id: string;
}

export async function listDlq(
  cursor: DlqCursor | null,
  limit: number,
): Promise<{ rows: DlqRow[]; hasMore: boolean }> {
  const result = await pool.query<DlqRow>(
    `SELECT d.id, d.event_id, d.endpoint_id, ev.event_type, d.status, d.attempt_count,
            d.next_attempt_at, d.created_at, d.updated_at,
            dlq_t.created_at AS dlq_entered_at
     FROM deliveries d
     JOIN events ev ON ev.id = d.event_id
     JOIN LATERAL (
       SELECT created_at FROM delivery_transitions
       WHERE delivery_id = d.id AND to_status = 'DLQ'
       ORDER BY id DESC
       LIMIT 1
     ) dlq_t ON true
     WHERE d.status = 'DLQ'
       AND ($1::timestamptz IS NULL OR (d.updated_at, d.id) < ($1::timestamptz, $2::uuid))
     ORDER BY d.updated_at DESC, d.id DESC
     LIMIT $3`,
    [cursor?.updatedAt ?? null, cursor?.id ?? null, limit + 1],
  );

  const hasMore = result.rows.length > limit;
  return { rows: result.rows.slice(0, limit), hasMore };
}

export type RetryFromDlqResult =
  | { ok: true }
  | { ok: false; reason: 'NOT_FOUND' }
  | { ok: false; reason: 'NOT_IN_DLQ'; currentStatus: string };

export async function retryFromDlq(deliveryId: string): Promise<RetryFromDlqResult> {
  return withTx(async (client) => {
    const result = await client.query<{ status: string }>(
      `SELECT status FROM deliveries WHERE id = $1 FOR UPDATE`,
      [deliveryId],
    );
    const row = result.rows[0];
    if (!row) return { ok: false, reason: 'NOT_FOUND' };
    if (row.status !== 'DLQ') {
      return { ok: false, reason: 'NOT_IN_DLQ', currentStatus: row.status };
    }

    await client.query(
      `UPDATE deliveries SET status = 'PENDING', updated_at = now() WHERE id = $1`,
      [deliveryId],
    );
    await client.query(
      `INSERT INTO delivery_transitions (delivery_id, from_status, to_status, reason, actor)
       VALUES ($1, 'DLQ', 'PENDING', 'manual_retry', 'manual-retry')`,
      [deliveryId],
    );

    return { ok: true };
  });
}
