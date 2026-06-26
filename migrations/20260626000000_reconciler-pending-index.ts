import type { MigrationBuilder } from 'node-pg-migrate';

// The reconciler's claimUnenqueued query was changed from
//   WHERE enqueued = false AND created_at < now() - make_interval(secs => $1)
// to
//   WHERE (status = 'PENDING' OR (status = 'FAILED' AND next_attempt_at < now()))
//     AND updated_at < now() - make_interval(secs => $1)
//
// This covers enqueued=true PENDING deliveries whose BullMQ jobs were lost
// after a Redis restart (the old query missed them entirely).
//
// The old partial index on (created_at) WHERE enqueued = false is no longer
// used by the reconciler; drop it and add one that matches the new predicate
// so the reconciler scan stays O(stuck rows) rather than O(all deliveries).
export const up = (pgm: MigrationBuilder): void => {
  pgm.sql(`
    DROP INDEX IF EXISTS idx_deliveries_unenqueued;

    -- Covers the PENDING arm of the new query.
    CREATE INDEX idx_deliveries_pending_stuck
      ON deliveries (updated_at)
      WHERE status = 'PENDING';

    -- Covers the FAILED-with-overdue-retry arm.
    CREATE INDEX idx_deliveries_failed_overdue
      ON deliveries (next_attempt_at)
      WHERE status = 'FAILED' AND next_attempt_at IS NOT NULL;
  `);
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.sql(`
    DROP INDEX IF EXISTS idx_deliveries_pending_stuck;
    DROP INDEX IF EXISTS idx_deliveries_failed_overdue;

    CREATE INDEX idx_deliveries_unenqueued
      ON deliveries (created_at)
      WHERE enqueued = false;
  `);
};
