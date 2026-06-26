import type { FastifyInstance } from 'fastify';
import { pool } from '../../db/pool.js';
import { webhookDeliveryQueue, webhookDlqQueue } from '../../queue/queues.js';
import { memoTtl } from '../../shared/memo.js';
import { config } from '../../shared/config.js';

interface DbStats {
  counts: Record<string, number>;
  oldest_pending_age_s: number | null;
}

const getDbStats = memoTtl(async (): Promise<DbStats> => {
  const [countsResult, ageResult] = await Promise.all([
    pool.query<{ status: string; count: number }>(
      'SELECT status, count(*)::int AS count FROM deliveries GROUP BY status',
    ),
    pool.query<{ age_s: number | null }>(
      'SELECT EXTRACT(EPOCH FROM (now() - min(created_at)))::float AS age_s' +
      ' FROM deliveries WHERE status = $1',
      ['PENDING'],
    ),
  ]);

  const counts: Record<string, number> = {
    PENDING: 0,
    DELIVERING: 0,
    DELIVERED: 0,
    FAILED: 0,
    DLQ: 0,
  };
  for (const row of countsResult.rows) {
    counts[row.status] = Number(row.count);
  }

  return {
    counts,
    oldest_pending_age_s: ageResult.rows[0]?.age_s ?? null,
  };
}, 2_000);

interface QueueDepths {
  'webhook-delivery': Record<string, number>;
  'webhook-dlq': Record<string, number>;
}

const getQueueStats = memoTtl(async (): Promise<QueueDepths> => {
  const [delivery, dlq] = await Promise.all([
    webhookDeliveryQueue.getJobCounts('wait', 'active', 'delayed', 'failed'),
    webhookDlqQueue.getJobCounts('wait', 'active'),
  ]);
  return { 'webhook-delivery': delivery, 'webhook-dlq': dlq };
}, config.QUEUE_DEPTH_CACHE_MS);

export async function statsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/stats', async (_req, reply) => {
    const [db, queues] = await Promise.all([getDbStats(), getQueueStats()]);

    const deliveryDepth = queues['webhook-delivery'];
    const wait = deliveryDepth['wait'] ?? 0;
    const delayed = deliveryDepth['delayed'] ?? 0;
    const backpressure_active = wait + delayed > config.BACKPRESSURE_QUEUE_LIMIT;

    return reply.send({
      deliveries: db.counts,
      queues,
      oldest_pending_age_s: db.oldest_pending_age_s,
      backpressure_active,
    });
  });
}
