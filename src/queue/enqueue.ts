import { pool } from '../db/pool.js';
import { webhookDeliveryQueue } from './queues.js';

export async function enqueueDelivery(deliveryId: string): Promise<void> {
  await webhookDeliveryQueue.add('deliver', { deliveryId }, { jobId: deliveryId });
  await pool.query(
    `UPDATE deliveries SET enqueued = true, updated_at = now() WHERE id = $1`,
    [deliveryId],
  );
}
