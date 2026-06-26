import { redis } from './client.js';
import { evalTokenBucket } from './scripts.js';
import { config } from '../shared/config.js';

// Per-endpoint in-flight cap: one dead-slow endpoint holding 50 workers
// hostage for 10s each would starve the entire pool for every other
// customer's deliveries. A rate-limited pickup is queue mechanics, not a
// delivery event — it must never consume an attempt or write a row (see
// processor.ts).

function bucketKey(endpointId: string): string {
  return `wh:rl:${endpointId}`;
}

/** Returns false (no rows written, caller must not burn an attempt) if the endpoint is at its cap. */
export async function tryAcquire(endpointId: string): Promise<boolean> {
  const remaining = await evalTokenBucket(
    bucketKey(endpointId),
    config.RL_MAX_INFLIGHT,
    config.RL_TTL_SECONDS,
  );
  return remaining !== -1;
}

/**
 * Plain HINCRBY, not a Lua script — unlike acquire, a benign over-cap race
 * here just means one extra job slips through briefly; the bucket
 * self-corrects (TTL expiry resets to RL_MAX_INFLIGHT via the script's
 * `or ARGV[1]` fallback on a missing key). Not worth a fourth Lua script.
 */
export async function release(endpointId: string): Promise<void> {
  const key = bucketKey(endpointId);
  const current = await redis.hincrby(key, 'tokens', 1);
  if (current > config.RL_MAX_INFLIGHT) {
    await redis.hset(key, 'tokens', config.RL_MAX_INFLIGHT);
  }
  await redis.expire(key, config.RL_TTL_SECONDS);
}
