import { z } from 'zod';
import { AppError } from './errors.js';

// Pulled forward from the Week 3 read-API plan because GET /v1/dlq needs
// keyset pagination now (API_SPEC.md §4 calls it "sugar for GET
// /v1/deliveries?status=DLQ, same shape") — when the general /v1/deliveries
// list lands, it reuses this exact module rather than re-inventing it.

export interface Cursor {
  updatedAt: string;
  id: string;
}

const cursorSchema = z.object({
  updatedAt: z.string(),
  id: z.string(),
});

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeCursor(value: string): Cursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    throw new AppError(400, 'INVALID_CURSOR', 'cursor is not valid base64/JSON');
  }

  const result = cursorSchema.safeParse(parsed);
  if (!result.success) {
    throw new AppError(400, 'INVALID_CURSOR', 'cursor failed validation', {
      issues: result.error.issues,
    });
  }
  return result.data;
}
