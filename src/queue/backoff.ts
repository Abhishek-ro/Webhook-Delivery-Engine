import { config } from '../shared/config.js';

export function webhookBackoff(attemptsMade: number): number {
  const base =
    config.BACKOFF_BASE_MS[attemptsMade - 1] ??
    config.BACKOFF_BASE_MS[config.BACKOFF_BASE_MS.length - 1]!;
  return Math.floor(base / 2 + Math.random() * (base / 2));
}
