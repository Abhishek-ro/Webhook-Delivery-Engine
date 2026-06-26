import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { listDlq, retryFromDlq } from '../../db/deliveries.repo.js';
import { webhookDeliveryQueue } from '../../queue/queues.js';
import { config } from '../../shared/config.js';
import { encodeCursor, decodeCursor } from '../cursor.js';
import { Errors } from '../errors.js';

const listQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export async function dlqRoutes(app: FastifyInstance) {
  app.get('/dlq', async (req) => {
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) throw Errors.validationError(parsed.error.issues);
    const { cursor: cursorParam, limit } = parsed.data;

    const cursor = cursorParam ? decodeCursor(cursorParam) : null;
    const { rows, hasMore } = await listDlq(
      cursor ? { updatedAt: new Date(cursor.updatedAt), id: cursor.id } : null,
      limit,
    );

    const last = rows[rows.length - 1];
    const nextCursor =
      hasMore && last ? encodeCursor({ updatedAt: last.updated_at.toISOString(), id: last.id }) : null;

    return { data: rows, next_cursor: nextCursor };
  });

  app.post('/dlq/:deliveryId/retry', async (req, reply) => {
    const { deliveryId } = req.params as { deliveryId: string };

    const result = await retryFromDlq(deliveryId);
    if (!result.ok) {
      if (result.reason === 'NOT_FOUND') throw Errors.deliveryNotFound(deliveryId);
      throw Errors.notInDlq(result.currentStatus);
    }

    // Fresh jobId, never the original deliveryId — BullMQ remembers
    // completed/failed job IDs and silently no-ops an `.add()` with one it's
    // already seen. Reusing the original here would mean a manual retry
    // that returns 202 and then nothing ever happens.
    const retryJobId = `${deliveryId}:retry:${Date.now()}`;
    await webhookDeliveryQueue.add('deliver', { deliveryId }, { jobId: retryJobId });

    return reply.code(202).send({
      delivery_id: deliveryId,
      status: 'PENDING',
      retry_job_id: retryJobId,
      attempt_budget: config.BACKOFF_BASE_MS.length,
    });
  });
}
