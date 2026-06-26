export function buildWebhookHeaders(
  deliveryId: string,
  attempt: number,
  timestampSeconds: number,
  signatureHex: string,
): Record<string, string> {
  return {
    'content-type': 'application/json',
    'x-webhook-id': deliveryId,
    'x-webhook-attempt': String(attempt),
    'x-webhook-timestamp': String(timestampSeconds),
    'x-webhook-signature': `sha256=${signatureHex}`,
  };
}
