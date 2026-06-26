import type { Job, Worker } from 'bullmq';
import { pool } from '../db/pool.js';
import { getForDelivery, transition } from '../db/deliveries.repo.js';
import { webhookDlqQueue } from '../queue/queues.js';
import { fireDlqAlert, type LastAttemptSummary } from '../shared/alerts.js';
import { config } from '../shared/config.js';
import { logger } from '../shared/logger.js';

/**
 * BullMQ emits 'failed' on *every* throw from the processor, not just the
 * final one — attempts 1-4 (with retries still budgeted) fire it too. The
 * job.attemptsMade >= BACKOFF_BASE_MS.length check is what tells this apart
 * from an ordinary retry; everything below it is a no-op for attempts that
 * still have budget left.
 */
export function registerDlqHandler(worker: Worker<{ deliveryId: string }>): void {
  worker.on('failed', (job) => {
    void handleFailed(job);
  });
}

// Exported (in addition to registerDlqHandler) so integration tests can
// drive the exhaustion path directly with a fake Job — same pattern as
// processor.guard.test.ts driving processDelivery — without needing a real
// BullMQ Worker and a real multi-hour backoff schedule in the loop.
export async function handleFailed(job: Job<{ deliveryId: string }> | undefined): Promise<void> {
  if (!job) return;

  const maxAttempts = config.BACKOFF_BASE_MS.length;
  if (job.attemptsMade < maxAttempts) return;

  const { deliveryId } = job.data;

  try {
    const delivery = await getForDelivery(deliveryId);
    if (!delivery) return;
    // Idempotent: if something already moved this delivery to DLQ (e.g. a
    // duplicate 'failed' emission), don't transition or alert twice.
    if (delivery.status === 'DLQ') return;

    await transition(deliveryId, delivery.status, 'DLQ', 'worker', 'attempts_exhausted');
    await webhookDlqQueue.add('dlq', { deliveryId }, { jobId: deliveryId });

    const lastAttemptResult = await pool.query<LastAttemptSummary>(
      `SELECT attempt_number, outcome, http_status, error_message
       FROM delivery_attempts
       WHERE delivery_id = $1
       ORDER BY attempt_number DESC
       LIMIT 1`,
      [deliveryId],
    );

    fireDlqAlert(delivery, lastAttemptResult.rows[0] ?? null);
  } catch (err) {
    logger.error({ deliveryId, err }, 'dlqHandler failed to process an exhausted delivery');
  }
}
