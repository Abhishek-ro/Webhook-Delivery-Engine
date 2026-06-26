import type { MigrationBuilder } from 'node-pg-migrate';

export const up = (pgm: MigrationBuilder): void => {
  pgm.sql(`
    CREATE TABLE endpoints (
      id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      client_id       text NOT NULL,
      url             text NOT NULL,
      signing_secret  text NOT NULL,
      is_active       boolean NOT NULL DEFAULT true,
      created_at      timestamptz NOT NULL DEFAULT now()
    );

    CREATE INDEX idx_endpoints_client ON endpoints (client_id);
  `);

  pgm.sql(`
    CREATE TABLE events (
      id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      client_id        text NOT NULL,
      idempotency_key  text NOT NULL,
      event_type       text NOT NULL,
      payload          jsonb NOT NULL,
      received_at      timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT uq_events_client_idem UNIQUE (client_id, idempotency_key)
    );
  `);

  pgm.sql(`
    CREATE TABLE deliveries (
      id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      event_id         uuid NOT NULL REFERENCES events(id),
      endpoint_id      uuid NOT NULL REFERENCES endpoints(id),
      status           text NOT NULL DEFAULT 'PENDING'
                         CHECK (status IN ('PENDING','DELIVERING','DELIVERED','FAILED','DLQ')),
      attempt_count    int  NOT NULL DEFAULT 0,
      next_attempt_at  timestamptz,
      enqueued         boolean NOT NULL DEFAULT false,
      created_at       timestamptz NOT NULL DEFAULT now(),
      updated_at       timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT uq_deliveries_event_endpoint UNIQUE (event_id, endpoint_id)
    );

    CREATE INDEX idx_deliveries_unenqueued
      ON deliveries (created_at)
      WHERE enqueued = false;

    CREATE INDEX idx_deliveries_status_updated
      ON deliveries (status, updated_at DESC);

    CREATE INDEX idx_deliveries_endpoint_created
      ON deliveries (endpoint_id, created_at DESC);

    CREATE INDEX idx_deliveries_event ON deliveries (event_id);
  `);

  pgm.sql(`
    CREATE TABLE delivery_attempts (
      id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      delivery_id     uuid NOT NULL REFERENCES deliveries(id),
      attempt_number  int  NOT NULL,
      outcome         text NOT NULL
                        CHECK (outcome IN (
                          'SUCCESS','HTTP_ERROR','TIMEOUT',
                          'CONN_ERROR','CIRCUIT_OPEN','LOCK_LOST'
                        )),
      http_status     int,
      response_body   text,
      error_message   text,
      latency_ms      int,
      started_at      timestamptz NOT NULL,
      finished_at     timestamptz NOT NULL,
      CONSTRAINT uq_attempts UNIQUE (delivery_id, attempt_number)
    );

    CREATE INDEX idx_attempts_delivery
      ON delivery_attempts (delivery_id, attempt_number);

    CREATE INDEX idx_attempts_brin
      ON delivery_attempts USING brin (started_at);
  `);

  pgm.sql(`
    CREATE TABLE delivery_transitions (
      id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      delivery_id  uuid NOT NULL REFERENCES deliveries(id),
      from_status  text,
      to_status    text NOT NULL,
      reason       text,
      actor        text NOT NULL DEFAULT 'worker'
                     CHECK (actor IN ('worker','api','reconciler','manual-retry')),
      created_at   timestamptz NOT NULL DEFAULT now()
    );

    CREATE INDEX idx_transitions_delivery
      ON delivery_transitions (delivery_id, id);

    CREATE INDEX idx_transitions_brin
      ON delivery_transitions USING brin (created_at);
  `);
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.sql(`
    DROP TABLE IF EXISTS delivery_transitions;
    DROP TABLE IF EXISTS delivery_attempts;
    DROP TABLE IF EXISTS deliveries;
    DROP TABLE IF EXISTS events;
    DROP TABLE IF EXISTS endpoints;
  `);
};
