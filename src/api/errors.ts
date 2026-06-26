export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const Errors = {
  idempotencyKeyMissing: () =>
    new AppError(400, 'IDEMPOTENCY_KEY_MISSING', 'Idempotency-Key header is required'),

  idempotencyKeyTooLong: () =>
    new AppError(400, 'IDEMPOTENCY_KEY_TOO_LONG', 'Idempotency-Key must be ≤ 255 characters'),

  payloadTooLarge: () =>
    new AppError(413, 'PAYLOAD_TOO_LARGE', 'Payload exceeds 256 KB limit'),

  endpointNotFound: (id: string) =>
    new AppError(404, 'ENDPOINT_NOT_FOUND', `Endpoint ${id} not found`),

  endpointInactive: (id: string) =>
    new AppError(409, 'ENDPOINT_INACTIVE', `Endpoint ${id} is not active`),

  backpressure: () =>
    new AppError(429, 'BACKPRESSURE', 'Queue depth exceeds threshold; retry after 5 seconds'),

  storageUnavailable: () =>
    new AppError(503, 'STORAGE_UNAVAILABLE', 'Database unavailable'),

  deliveryNotFound: (id: string) =>
    new AppError(404, 'DELIVERY_NOT_FOUND', `Delivery ${id} not found`),

  notInDlq: (currentStatus: string) =>
    new AppError(409, 'NOT_IN_DLQ', `Delivery is not in DLQ (current status: ${currentStatus})`, {
      current_status: currentStatus,
    }),

  validationError: (issues: unknown) =>
    new AppError(400, 'VALIDATION_ERROR', 'Request validation failed', { issues }),
} as const;
