import { Redis } from 'ioredis';
import { config } from '../shared/config.js';
import { logger } from '../shared/logger.js';

export const redis = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: null,
  lazyConnect: true,
  enableReadyCheck: true,
});

redis.on('error', (err: Error) => {
  logger.error({ err: err.message }, 'redis connection error');
});
