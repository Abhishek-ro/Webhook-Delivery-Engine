import { randomBytes } from 'node:crypto';
import { redis } from './client.js';
import { evalReleaseLock, evalExtendLock } from './scripts.js';
import { config } from '../shared/config.js';

// Belt-and-suspenders on top of BullMQ's own job lock: BullMQ's lock keeps
// two workers from picking up the *same job*, but it does nothing once a
// job stalls past lockDuration — BullMQ will hand it to another worker
// while the first one may still be mid-HTTP-call. This per-delivery Redis
// lock + token + heartbeat is what makes that handoff safe. The rule that
// matters: never write a terminal status without holding this lock.

export function lockKey(deliveryId: string): string {
  return `wh:lock:${deliveryId}`;
}

export interface AcquireResult {
  acquired: boolean;
  token: string;
}

export async function acquire(deliveryId: string): Promise<AcquireResult> {
  const token = randomBytes(16).toString('hex');
  const result = await redis.set(lockKey(deliveryId), token, 'PX', config.LOCK_TTL_MS, 'NX');
  return { acquired: result === 'OK', token };
}

/** Returns false if we no longer hold the lock (wrong token, expired, stolen). */
export async function release(deliveryId: string, token: string): Promise<boolean> {
  const result = await evalReleaseLock(lockKey(deliveryId), token);
  return result === 1;
}

/** Returns false if we no longer hold the lock — caller must abort and record LOCK_LOST. */
export async function extend(deliveryId: string, token: string): Promise<boolean> {
  const result = await evalExtendLock(lockKey(deliveryId), token, config.LOCK_TTL_MS);
  return result === 1;
}
