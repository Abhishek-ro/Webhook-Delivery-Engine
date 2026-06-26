import { extend } from '../redis/lock.js';
import { config } from '../shared/config.js';

/**
 * Wraps a unit of work (the HTTP delivery call) with a lock heartbeat.
 * Every `LOCK_HEARTBEAT_INTERVAL_MS` it calls `extend()`; if that ever
 * returns false (TTL expired, or another worker now owns the lock), it
 * calls `onLockLost()` and aborts the in-flight work via the AbortSignal
 * handed to `fn` — `deliver()` already honors that signal. The caller is
 * responsible for treating the outcome as LOCK_LOST regardless of whether
 * `fn` happened to resolve successfully in the same tick (see
 * processor.ts) — once the lock is gone, nothing it produced counts.
 */
export async function withLockHeartbeat<T>(
  deliveryId: string,
  token: string,
  onLockLost: () => void,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();

  const interval = setInterval(() => {
    void extend(deliveryId, token).then((stillHeld) => {
      if (!stillHeld) {
        onLockLost();
        controller.abort();
      }
    });
  }, config.LOCK_HEARTBEAT_INTERVAL_MS);

  try {
    return await fn(controller.signal);
  } finally {
    clearInterval(interval);
  }
}
