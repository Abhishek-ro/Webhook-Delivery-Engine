/**
 * Wraps an async function in a TTL cache with in-flight de-duplication: a
 * cache miss kicks off exactly one call to `fn`, and every caller that
 * shows up while it's still pending shares that same promise rather than
 * each firing their own — without that, a queue-depth check on the hot
 * path of every POST /v1/events would mean N concurrent requests during a
 * cache miss turn into N redundant `getJobCounts()` calls.
 *
 * Pulled forward from Week 3 Day 1's plan (`memoTtl`) because backpressure
 * needs this now; Week 3's `/v1/stats` endpoint will be the second caller,
 * not a reason to write a second implementation.
 */
export function memoTtl<T>(fn: () => Promise<T>, ttlMs: number): () => Promise<T> {
  let cached: { value: T; expiresAt: number } | null = null;
  let pending: Promise<T> | null = null;

  return async (): Promise<T> => {
    const now = Date.now();
    if (cached && cached.expiresAt > now) {
      return cached.value;
    }
    if (pending) {
      return pending;
    }

    pending = fn()
      .then((value) => {
        cached = { value, expiresAt: Date.now() + ttlMs };
        pending = null;
        return value;
      })
      .catch((err: unknown) => {
        pending = null;
        throw err;
      });

    return pending;
  };
}
