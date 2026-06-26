import { withTx } from './pool.js';

export type AttemptOutcome =
  | 'SUCCESS'
  | 'HTTP_ERROR'
  | 'TIMEOUT'
  | 'CONN_ERROR'
  | 'CIRCUIT_OPEN'
  | 'LOCK_LOST';

export interface RecordAttemptInput {
  deliveryId: string;
  attemptNumber: number;
  outcome: AttemptOutcome;
  httpStatus: number | null;
  responseBody: string | null;
  errorMessage: string | null;
  latencyMs: number;
  startedAt: Date;
  finishedAt: Date;
  fromStatus: string;
  toStatus: string;
  reason: string;
  nextAttemptAt: Date | null;
}

export async function recordAttempt(input: RecordAttemptInput): Promise<void> {
  await withTx(async (client) => {
    await client.query(
      `INSERT INTO delivery_attempts
         (delivery_id, attempt_number, outcome, http_status, response_body, error_message, latency_ms, started_at, finished_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        input.deliveryId,
        input.attemptNumber,
        input.outcome,
        input.httpStatus,
        input.responseBody,
        input.errorMessage,
        input.latencyMs,
        input.startedAt,
        input.finishedAt,
      ],
    );

    await client.query(
      `UPDATE deliveries
       SET status = $2, attempt_count = attempt_count + 1, next_attempt_at = $3, updated_at = now()
       WHERE id = $1`,
      [input.deliveryId, input.toStatus, input.nextAttemptAt],
    );

    await client.query(
      `INSERT INTO delivery_transitions (delivery_id, from_status, to_status, reason, actor)
       VALUES ($1, $2, $3, $4, 'worker')`,
      [input.deliveryId, input.fromStatus, input.toStatus, input.reason],
    );
  });
}
