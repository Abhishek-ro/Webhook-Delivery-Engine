import Fastify from 'fastify';
import { AppError } from './errors.js';
import { endpointsRoutes } from './routes/endpoints.js';
import { eventsRoutes } from './routes/events.js';
import { dlqRoutes } from './routes/dlq.js';
import { deliveriesRoutes } from './routes/deliveries.js';
import { statsRoutes } from './routes/stats.js';
import { pool } from '../db/pool.js';
import { redis } from '../redis/client.js';
import { config } from '../shared/config.js';

export function buildApp() {
  const app = Fastify({ logger: true, bodyLimit: config.MAX_PAYLOAD_BYTES });

  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof AppError) {
      if (error.statusCode === 429) {
        void reply.header('Retry-After', '5');
      }
      return reply.code(error.statusCode).send({
        error: { code: error.code, message: error.message, details: error.details },
      });
    }

    if ((error as { code?: string }).code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      return reply.code(413).send({
        error: { code: 'PAYLOAD_TOO_LARGE', message: 'Payload exceeds 256 KB limit', details: {} },
      });
    }

    if (error.validation) {
      return reply.code(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          details: { issues: error.validation },
        },
      });
    }

    app.log.error(error);
    return reply.code(500).send({
      error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred', details: {} },
    });
  });

  app.get('/healthz', async () => ({ ok: true }));

  app.get('/readyz', async (_req, reply) => {
    const status: Record<string, 'ok' | 'error'> = { postgres: 'ok', redis: 'ok' };
    let healthy = true;

    try {
      await pool.query('SELECT 1');
    } catch {
      status['postgres'] = 'error';
      healthy = false;
    }

    try {
      await redis.ping();
    } catch {
      status['redis'] = 'error';
      healthy = false;
    }

    return reply.code(healthy ? 200 : 503).send(status);
  });

  void app.register(endpointsRoutes, { prefix: '/v1' });
  void app.register(eventsRoutes, { prefix: '/v1' });
  void app.register(dlqRoutes, { prefix: '/v1' });
  void app.register(deliveriesRoutes, { prefix: '/v1' });
  void app.register(statsRoutes, { prefix: '/v1' });

  return app;
}
