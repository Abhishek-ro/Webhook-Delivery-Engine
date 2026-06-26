import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),
  PORT: z.coerce.number().int().positive().default(3000),

  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(50),

  HTTP_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  LOCK_TTL_MS: z.coerce.number().int().positive().default(60_000),
  LOCK_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().positive().default(20_000),
  BULLMQ_LOCK_DURATION_MS: z.coerce.number().int().positive().default(90_000),
  BULLMQ_STALLED_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),

  RECONCILER_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
  RECONCILER_GRACE_SECONDS: z.coerce.number().int().positive().default(60),
  RECONCILER_BATCH_SIZE: z.coerce.number().int().positive().default(500),

  REMOVE_ON_COMPLETE_AGE_S: z.coerce.number().int().positive().default(3_600),
  REMOVE_ON_COMPLETE_COUNT: z.coerce.number().int().positive().default(10_000),

  BACKOFF_BASE_MS: z
    .string()
    .default('10000,30000,120000,600000,3600000')
    .transform((s) => s.split(',').map(Number)),

  BACKPRESSURE_QUEUE_LIMIT: z.coerce.number().int().positive().default(50_000),
  QUEUE_DEPTH_CACHE_MS: z.coerce.number().int().positive().default(1_000),

  CB_FAIL_THRESHOLD: z.coerce.number().int().positive().default(20),
  CB_WINDOW_SECONDS: z.coerce.number().int().positive().default(300),
  CB_OPEN_SECONDS: z.coerce.number().int().positive().default(60),
  CB_PROBE_SECONDS: z.coerce.number().int().positive().default(10),

  RL_MAX_INFLIGHT: z.coerce.number().int().positive().default(50),
  RL_TTL_SECONDS: z.coerce.number().int().positive().default(120),
  RL_RATE_LIMITED_DELAY_MS: z.coerce.number().int().positive().default(5_000),

  IDEM_TTL_SECONDS: z.coerce.number().int().positive().default(86_400),

  MAX_PAYLOAD_BYTES: z.coerce.number().int().positive().default(256 * 1024),
  MAX_RESPONSE_BODY_BYTES: z.coerce.number().int().positive().default(4 * 1024),

  ALERT_WEBHOOK_URL: z.string().url().optional(),
});

export type Config = z.infer<typeof schema>;

const result = schema.safeParse(process.env);

if (!result.success) {
  // Can't use logger.ts here: it has no dependency on config, but keeping
  // config self-contained avoids any import-order surprises during startup
  // failure (the one moment we most need the error to actually print).
  console.error('Invalid configuration:');
  console.error(result.error.flatten().fieldErrors);
  process.exit(1);
}

export const config: Config = result.data;
