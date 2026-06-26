import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../../db/pool.js';
import { redis } from '../../redis/client.js';
import { ingestEvent } from '../../db/ingest.js';
import { AppError, Errors } from '../errors.js';
import { config } from '../../shared/config.js';
import { enqueueDelivery } from '../../queue/enqueue.js';
import { isOverloaded } from '../backpressure.js';

const eventBodySchema = z.object({
  endpoint_id: z.string().uuid('endpoint_id must be a UUID'),
  event_type: z.string().min(1).max(255),
  payload: z.record(z.unknown()),
});

export async function eventsRoutes(app: FastifyInstance) {
  app.post('/events', async (req, reply) => {
    // Shed at the edge: checked first, before Idempotency-Key validation,
    // before Redis, before Postgres. The check itself is cheap (1s
    // memoized BullMQ getJobCounts), so there's no cost reason to put
    // anything ahead of it — and every check after this one does real work
    // an overloaded system shouldn't be asked to do.
    if (await isOverloaded()) {
      throw Errors.backpressure();
    }

    const idemKey = req.headers['idempotency-key'];
    if (!idemKey || typeof idemKey !== 'string') {
      throw new AppError(400, 'IDEMPOTENCY_KEY_MISSING', 'Idempotency-Key header is required');
    }
    if (idemKey.length > 255) {
      throw new AppError(400, 'IDEMPOTENCY_KEY_TOO_LONG', 'Idempotency-Key must be ≤ 255 characters');
    }

    const contentLength = parseInt(String(req.headers['content-length'] ?? '0'), 10);
    if (contentLength > config.MAX_PAYLOAD_BYTES) {
      throw new AppError(413, 'PAYLOAD_TOO_LARGE', 'Payload exceeds 256 KB limit');
    }

    const parsed = eventBodySchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Validation failed', { issues: parsed.error.issues });
    }
    const { endpoint_id, event_type, payload } = parsed.data;

    const rawBody = JSON.stringify(payload);
    if (Buffer.byteLength(rawBody, 'utf8') > config.MAX_PAYLOAD_BYTES) {
      throw new AppError(413, 'PAYLOAD_TOO_LARGE', 'Payload exceeds 256 KB limit');
    }

    let endpoint: { id: string; client_id: string; is_active: boolean };
    try {
      const result = await pool.query<{ id: string; client_id: string; is_active: boolean }>(
        `SELECT id, client_id, is_active FROM endpoints WHERE id = $1`,
        [endpoint_id],
      );
      const row = result.rows[0];
      if (!row) throw new AppError(404, 'ENDPOINT_NOT_FOUND', `Endpoint ${endpoint_id} not found`);
      endpoint = row;
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw new AppError(503, 'STORAGE_UNAVAILABLE', 'Database unavailable');
    }

    if (!endpoint.is_active) {
      throw new AppError(409, 'ENDPOINT_INACTIVE', `Endpoint ${endpoint_id} is not active`);
    }

    const result = await ingestEvent(pool, redis, {
      client_id: endpoint.client_id,
      idempotency_key: idemKey,
      event_type,
      payload,
      endpoint_id,
    });

    if (result.is_new) {
      if (process.env['CRASH_AFTER_COMMIT'] === '1') {
        process.exit(1);
      }
      try {
        await enqueueDelivery(result.delivery_id);
      } catch (err) {
        app.log.error({ err, delivery_id: result.delivery_id }, 'enqueue failed — reconciler will recover');
      }
    }

    return reply.code(result.is_new ? 202 : 200).send({
      event_id: result.event_id,
      delivery_id: result.delivery_id,
      status: result.delivery_status,
      duplicate: !result.is_new,
    });
  });
}
