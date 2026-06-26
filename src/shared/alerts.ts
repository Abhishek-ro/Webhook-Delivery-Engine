import { request } from 'undici';
import { logger } from './logger.js';
import { config } from './config.js';
import type { DeliveryForWorker } from '../db/deliveries.repo.js';

export interface LastAttemptSummary {
  attempt_number: number;
  outcome: string;
  http_status: number | null;
  error_message: string | null;
}

/**
 * Called once a delivery has exhausted all attempts and moved to the DLQ.
 * The structured log line always happens — that's the durable record. The
 * outbound webhook (if ALERT_WEBHOOK_URL is set) is best-effort on top of
 * that, fire-and-forget: a failure to alert must never retry, never recurse
 * back into a worker event handler, and never throw — that's how an alerting
 * outage turns into a second incident.
 */
export function fireDlqAlert(
  delivery: DeliveryForWorker,
  lastAttempt: LastAttemptSummary | null,
): void {
  logger.error(
    {
      deliveryId: delivery.id,
      endpointUrl: delivery.endpointUrl,
      lastAttempt,
    },
    'delivery exhausted all attempts — moved to DLQ',
  );

  if (!config.ALERT_WEBHOOK_URL) return;

  void request(config.ALERT_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      event: 'delivery.dlq',
      delivery_id: delivery.id,
      endpoint_url: delivery.endpointUrl,
      last_attempt: lastAttempt,
    }),
  }).catch((err: unknown) => {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      'DLQ alert webhook failed to send',
    );
  });
}
