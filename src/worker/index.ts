import { Worker } from 'bullmq';
import { config } from '../shared/config.js';
import { logger } from '../shared/logger.js';
import { webhookBackoff } from '../queue/backoff.js';
import { processDelivery } from './processor.js';
import { registerDlqHandler } from './dlqHandler.js';

function makeBullConnection() {
  const u = new URL(config.REDIS_URL);
  return {
    host: u.hostname,
    port: u.port ? Number(u.port) : 6379,
    maxRetriesPerRequest: null as null,
    enableReadyCheck: false,
  };
}

const worker = new Worker('webhook-delivery', processDelivery, {
  connection: makeBullConnection(),
  concurrency: config.WORKER_CONCURRENCY,
  lockDuration: config.BULLMQ_LOCK_DURATION_MS,
  stalledInterval: config.BULLMQ_STALLED_INTERVAL_MS,
  maxStalledCount: 1,
  settings: {
    backoffStrategy: (attemptsMade, type) => {
      if (type === 'webhook-backoff') return webhookBackoff(attemptsMade);
      return 1_000;
    },
  },
});

worker.on('failed', (job, err) => {
  logger.error(
    { jobId: job?.id, attempt: job?.attemptsMade, err: err.message },
    'job failed',
  );
});

// Separate listener, same event: this one decides whether the failure was
// the *final* one (attempts exhausted) and moves the delivery to the DLQ.
// Keeping it in its own module/listener instead of folding it into the
// logging handler above keeps "log that something failed" and "decide the
// delivery is dead" from tangling into one function.
registerDlqHandler(worker);

worker.on('error', (err) => {
  logger.error({ err: err.message }, 'worker error');
});

async function shutdown(): Promise<void> {
  await worker.close();
}

process.on('SIGTERM', () => {
  void shutdown();
});
