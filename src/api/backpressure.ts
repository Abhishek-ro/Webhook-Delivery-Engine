import { webhookDeliveryQueue } from '../queue/queues.js';
import { config } from '../shared/config.js';
import { memoTtl } from '../shared/memo.js';

// The cheap path is to let the queue absorb everything and call it
// "scalable" — delivery lag grows unboundedly and nobody notices until
// it's hours. Shed at the edge instead: once wait+delayed exceeds the
// threshold, reject new ingestion with 429 before it ever touches Redis or
// Postgres, rather than letting the backlog grow silently.
const getCounts = memoTtl(
  () => webhookDeliveryQueue.getJobCounts('wait', 'delayed'),
  config.QUEUE_DEPTH_CACHE_MS,
);

export async function isOverloaded(): Promise<boolean> {
  const counts = await getCounts();
  const depth = (counts['wait'] ?? 0) + (counts['delayed'] ?? 0);
  return depth > config.BACKPRESSURE_QUEUE_LIMIT;
}
