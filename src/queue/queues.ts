import { Queue } from 'bullmq';
import { config } from '../shared/config.js';

function makeBullConnection() {
  const u = new URL(config.REDIS_URL);
  return {
    host: u.hostname,
    port: u.port ? Number(u.port) : 6379,
    maxRetriesPerRequest: null as null,
    enableReadyCheck: false,
  };
}

export const webhookDeliveryQueue = new Queue('webhook-delivery', {
  connection: makeBullConnection(),
  defaultJobOptions: {
    attempts: config.BACKOFF_BASE_MS.length,
    backoff: { type: 'webhook-backoff' },
    removeOnComplete: {
      age: config.REMOVE_ON_COMPLETE_AGE_S,
      count: config.REMOVE_ON_COMPLETE_COUNT,
    },
    removeOnFail: false,
  },
});

export const webhookDlqQueue = new Queue('webhook-dlq', {
  connection: makeBullConnection(),
});
