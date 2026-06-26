import type { Pool } from 'pg';
import type { Redis } from 'ioredis';
import { config } from '../shared/config.js';

interface IngestParams {
  client_id: string;
  idempotency_key: string;
  event_type: string;
  payload: unknown;
  endpoint_id: string;
}

export interface IngestResult {
  event_id: string;
  delivery_id: string;
  delivery_status: string;
  is_new: boolean;
}

export async function ingestEvent(
  pool: Pool,
  redis: Redis,
  params: IngestParams,
): Promise<IngestResult> {
  const { client_id, idempotency_key, event_type, payload, endpoint_id } = params;
  const idemRedisKey = `wh:idem:${client_id}:${idempotency_key}`;

  const cachedEventId = await redis.get(idemRedisKey);
  if (cachedEventId) {
    const row = await pool.query<{ delivery_id: string; delivery_status: string }>(
      `SELECT d.id AS delivery_id, d.status AS delivery_status
       FROM deliveries d
       WHERE d.event_id = $1
       LIMIT 1`,
      [cachedEventId],
    );
    const delivery = row.rows[0];
    if (delivery) {
      return {
        event_id: cachedEventId,
        delivery_id: delivery.delivery_id,
        delivery_status: delivery.delivery_status,
        is_new: false,
      };
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const eventInsert = await client.query<{ id: string }>(
      `INSERT INTO events (client_id, idempotency_key, event_type, payload)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (client_id, idempotency_key) DO NOTHING
       RETURNING id`,
      [client_id, idempotency_key, event_type, JSON.stringify(payload)],
    );

    let eventId: string;
    let isNew: boolean;

    if (eventInsert.rows[0]) {
      eventId = eventInsert.rows[0].id;
      isNew = true;
    } else {
      const existing = await client.query<{ id: string }>(
        `SELECT id FROM events WHERE client_id = $1 AND idempotency_key = $2`,
        [client_id, idempotency_key],
      );
      eventId = existing.rows[0]!.id;
      isNew = false;
    }

    let deliveryId: string;
    let deliveryStatus: string;

    if (isNew) {
      const deliveryInsert = await client.query<{ id: string }>(
        `INSERT INTO deliveries (event_id, endpoint_id, status, enqueued)
         VALUES ($1, $2, 'PENDING', false)
         RETURNING id`,
        [eventId, endpoint_id],
      );
      deliveryId = deliveryInsert.rows[0]!.id;
      deliveryStatus = 'PENDING';

      await client.query(
        `INSERT INTO delivery_transitions (delivery_id, from_status, to_status, reason, actor)
         VALUES ($1, NULL, 'PENDING', 'created', 'api')`,
        [deliveryId],
      );
    } else {
      const existingDelivery = await client.query<{ id: string; status: string }>(
        `SELECT id, status FROM deliveries WHERE event_id = $1 LIMIT 1`,
        [eventId],
      );
      const d = existingDelivery.rows[0]!;
      deliveryId = d.id;
      deliveryStatus = d.status;
    }

    await client.query('COMMIT');

    void redis.set(idemRedisKey, eventId, 'EX', config.IDEM_TTL_SECONDS);

    return { event_id: eventId, delivery_id: deliveryId, delivery_status: deliveryStatus, is_new: isNew };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
