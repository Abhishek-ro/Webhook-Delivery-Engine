import { createHmac, timingSafeEqual } from 'node:crypto';

export function sign(secret: string, timestampSeconds: number, rawBody: string): string {
  const signedPayload = `${timestampSeconds}.${rawBody}`;
  return createHmac('sha256', secret).update(signedPayload).digest('hex');
}

export function verify(
  secret: string,
  timestampSeconds: number,
  rawBody: string,
  signatureHex: string,
): boolean {
  const expectedHex = sign(secret, timestampSeconds, rawBody);
  const expected = Buffer.from(expectedHex, 'hex');
  const actual = Buffer.from(signatureHex, 'hex');
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}
