import type { Job } from 'bullmq';
import { DelayedError } from 'bullmq';
import { config } from '../shared/config.js';
import { buildWebhookHeaders } from '../shared/headers.js';
import { webhookBackoff } from '../queue/backoff.js';
import { getForDelivery, transition } from '../db/deliveries.repo.js';
import { recordAttempt, type AttemptOutcome } from '../db/attempts.repo.js';
import { deliver, DeliverError } from './httpClient.js';
import { sign } from './signature.js';
import { acquire, release } from '../redis/lock.js';
import { withLockHeartbeat } from './heartbeat.js';
import { checkState, recordFailure, onProbeResult } from '../redis/circuitBreaker.js';
import { tryAcquire, release as releaseBucketToken } from '../redis/tokenBucket.js';

const INACTIVE_ENDPOINT_DELAY_MS = 60_000;
const RATE_LIMIT_DELAY_MS = 5_000;
const RATE_LIMIT_JITTER_MS = 2_000;
const LOCK_CONTENTION_DELAY_MS = 5_000;

/** LOCK_LOST is about our own infra losing the lock, not the endpoint's health — it must never feed the breaker. */
function isRealFailureOutcome(outcome: AttemptOutcome): boolean {
  return outcome === 'HTTP_ERROR' || outcome === 'TIMEOUT' || outcome === 'CONN_ERROR';
}

export async function processDelivery(
  job: Job<{ deliveryId: string }>,
  token?: string,
): Promise<void> {
  const { deliveryId } = job.data;
  const dbg = (msg: string) => console.log(`[RL-DBG ${deliveryId.slice(-6)}] ${msg}`);

  // Acquire the per-delivery Redis lock *before* touching status at all.
  // Not acquired means another worker currently owns this delivery. Delay
  // and retry rather than silently returning: a bare `return` would cause
  // BullMQ to complete the job as "succeeded", removing it from the queue
  // and leaving the delivery unreachable until the reconciler recovers it
  // (or not at all, if `enqueued = true`). This is not a delivery failure,
  // so we must not burn an attempt — DelayedError achieves exactly that.
  dbg('acquiring lock');
  const lock = await acquire(deliveryId);
  dbg(`lock.acquired=${lock.acquired}`);
  if (!lock.acquired) {
    dbg('lock contention → moveToDelayed');
    await job.moveToDelayed(Date.now() + LOCK_CONTENTION_DELAY_MS, token);
    throw new DelayedError();
  }

  // Hoisted so the `finally` below can release the bucket token even though
  // `delivery` itself is scoped inside the try block.
  let endpointId: string | undefined;
  let bucketAcquired = false;

  try {
    // Status re-read happens only *after* we hold the lock — reading it
    // before would race with whoever holds the lock right now.
    const delivery = await getForDelivery(deliveryId);
    dbg(`getForDelivery=${delivery ? delivery.status : 'null'}`);
    if (!delivery) return;
    if (delivery.status === 'DELIVERED' || delivery.status === 'DLQ') return;
    endpointId = delivery.endpointId;

    // Attempt number comes from the delivery's own persisted attempt_count,
    // not job.attemptsMade. They agree for an ordinary BullMQ-scheduled
    // retry (same jobId throughout), but a manual DLQ retry creates a
    // *fresh* job with attemptsMade back at 0 — using that would silently
    // restart the audit trail at attempt_1 instead of continuing at 6,
    // which API_SPEC.md §4 explicitly rules out ("the audit trail never
    // resets").
    const attemptNumber = delivery.attemptCount + 1;

    if (!delivery.endpointActive) {
      dbg('endpoint inactive → moveToDelayed');
      await job.moveToDelayed(Date.now() + INACTIVE_ENDPOINT_DELAY_MS, token);
      throw new DelayedError();
    }

    const fromStatus = delivery.status;

    // Circuit breaker: an endpoint that's failed CB_FAIL_THRESHOLD times in
    // the last CB_WINDOW_SECONDS gets failed fast instead of burning a
    // socket and HTTP_TIMEOUT_MS on an endpoint that's already proven dead.
    // This *does* consume an attempt and go through normal backoff —
    // failing fast repeatedly still drives the delivery toward DLQ, which
    // is the correct outcome for a genuinely dead endpoint.
    const breakerState = await checkState(endpointId);
    dbg(`breakerState=${breakerState}`);
    if (breakerState === 'open') {
      const now = new Date();
      await recordAttempt({
        deliveryId,
        attemptNumber,
        outcome: 'CIRCUIT_OPEN',
        httpStatus: null,
        responseBody: null,
        errorMessage: 'circuit_open',
        latencyMs: 0,
        startedAt: now,
        finishedAt: now,
        fromStatus,
        toStatus: 'FAILED',
        reason: 'circuit_open',
        nextAttemptAt: new Date(Date.now() + webhookBackoff(attemptNumber)),
      });
      throw new Error('circuit_open');
    }

    // Per-endpoint in-flight cap. Unlike the breaker, a rate-limited pickup
    // is not a delivery event at all — no attempt row, no transition,
    // status left exactly as it was. It just means "try again in a few
    // seconds", not "this delivery failed".
    dbg('calling tryAcquire');
    try {
      bucketAcquired = await tryAcquire(endpointId);
    } catch (err) {
      dbg(`tryAcquire THREW: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
    dbg(`tryAcquire=${bucketAcquired}`);
    if (!bucketAcquired) {
      dbg('rate-limited → moveToDelayed');
      const jitterMs = Math.random() * RATE_LIMIT_JITTER_MS * 2 - RATE_LIMIT_JITTER_MS;
      await job.moveToDelayed(Date.now() + RATE_LIMIT_DELAY_MS + jitterMs, token);
      dbg('moveToDelayed done');
      throw new DelayedError();
    }
    dbg('got token, proceeding to HTTP call');

    await transition(deliveryId, fromStatus, 'DELIVERING', 'worker', `attempt_${attemptNumber}`);

    const outboundBody = JSON.stringify({
      event_id: delivery.eventId,
      event_type: delivery.eventType,
      created_at: delivery.receivedAt.toISOString(),
      data: delivery.payload,
    });
    const timestampSeconds = Math.floor(Date.now() / 1000);
    const signatureHex = sign(delivery.signingSecret, timestampSeconds, outboundBody);
    const headers = buildWebhookHeaders(deliveryId, attemptNumber, timestampSeconds, signatureHex);

    const startedAt = new Date();
    let finishedAt: Date;
    let outcome: AttemptOutcome;
    let httpStatus: number | null = null;
    let responseBody: string | null = null;
    let errorMessage: string | null = null;
    let reason: string;

    // Heartbeat extends the lock every LOCK_HEARTBEAT_INTERVAL_MS while the
    // HTTP call is in flight. If extend() ever comes back false — TTL
    // expired, or another worker now holds it — lockLost flips to true and
    // the in-flight request is aborted via the signal `deliver()` honors.
    let lockLost = false;
    try {
      const result = await withLockHeartbeat(
        deliveryId,
        lock.token,
        () => {
          lockLost = true;
        },
        (signal) => deliver(delivery.endpointUrl, outboundBody, headers, signal),
      );
      finishedAt = new Date();

      if (lockLost) {
        // The HTTP call may have technically completed (even with a 2xx)
        // in the same tick the lock was declared lost — that result is not
        // trustworthy proof that *we* delivered it under a lock we no
        // longer hold. Never write DELIVERED here.
        outcome = 'LOCK_LOST';
        errorMessage = 'lock_lost';
        reason = 'lock_lost';
      } else {
        httpStatus = result.status;
        responseBody = result.body;
        reason = `http_${result.status}`;
        if (result.status >= 200 && result.status < 300) {
          outcome = 'SUCCESS';
        } else {
          outcome = 'HTTP_ERROR';
          errorMessage = `HTTP ${result.status}`;
        }
      }
    } catch (err) {
      finishedAt = new Date();
      if (lockLost) {
        outcome = 'LOCK_LOST';
        errorMessage = 'lock_lost';
        reason = 'lock_lost';
      } else if (err instanceof DeliverError) {
        outcome = err.kind;
        errorMessage = err.message;
        reason =
          err.kind === 'TIMEOUT' ? `timeout_${config.HTTP_TIMEOUT_MS / 1000}s` : 'conn_error';
      } else {
        outcome = 'CONN_ERROR';
        errorMessage = err instanceof Error ? err.message : String(err);
        reason = 'conn_error';
      }
    }

    // Breaker bookkeeping based on what actually happened. A 'probe' attempt
    // reports its single result either way (close it back up, or re-open
    // immediately); an ordinary 'closed' attempt only feeds the failure
    // counter — LOCK_LOST never touches the breaker either way.
    if (breakerState === 'probe') {
      await onProbeResult(endpointId, outcome === 'SUCCESS');
    } else if (isRealFailureOutcome(outcome)) {
      await recordFailure(endpointId);
    }

    const latencyMs = finishedAt.getTime() - startedAt.getTime();
    const toStatus = outcome === 'SUCCESS' ? 'DELIVERED' : 'FAILED';
    const nextAttemptAt =
      outcome === 'SUCCESS' ? null : new Date(Date.now() + webhookBackoff(attemptNumber));

    await recordAttempt({
      deliveryId,
      attemptNumber,
      outcome,
      httpStatus,
      responseBody,
      errorMessage,
      latencyMs,
      startedAt,
      finishedAt,
      fromStatus: 'DELIVERING',
      toStatus,
      reason,
      nextAttemptAt,
    });

    if (outcome !== 'SUCCESS') {
      throw new Error(reason);
    }
  } finally {
    // bucketAcquired only flips true once tryAcquire() actually succeeds —
    // it stays false for the rate-limited-pickup path itself (nothing to
    // release, we never got a token), the circuit-open path (never reached
    // the bucket check), and the lock-not-acquired early return. Only a
    // delivery that actually held a bucket token releases one here.
    if (bucketAcquired && endpointId) {
      await releaseBucketToken(endpointId);
    }
    // Token-checked: if we no longer hold the lock (already lost it), this
    // is a harmless no-op rather than deleting whoever's lock it is now.
    await release(deliveryId, lock.token);
  }
}
