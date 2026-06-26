import { Agent, request } from 'undici';
import { config } from '../shared/config.js';

const agent = new Agent({
  connections: 128,
  pipelining: 1,
  keepAliveTimeout: 30_000,
  keepAliveMaxTimeout: 60_000,
});

export type DeliverErrorKind = 'TIMEOUT' | 'CONN_ERROR';

export class DeliverError extends Error {
  kind: DeliverErrorKind;

  constructor(kind: DeliverErrorKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

export interface DeliverResult {
  status: number;
  body: string;
  latencyMs: number;
}

function classify(err: unknown): DeliverErrorKind {
  if (err instanceof Error) {
    const msg = err.message;
    if (
      err.name === 'AbortError' ||
      msg.includes('UND_ERR_HEADERS_TIMEOUT') ||
      msg.includes('UND_ERR_BODY_TIMEOUT') ||
      msg.includes('UND_ERR_CONNECT_TIMEOUT')
    ) {
      return 'TIMEOUT';
    }
  }
  return 'CONN_ERROR';
}

export async function deliver(
  url: string,
  body: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<DeliverResult> {
  const startedAt = Date.now();
  try {
    const resp = await request(url, {
      method: 'POST',
      headers,
      body,
      dispatcher: agent,
      headersTimeout: config.HTTP_TIMEOUT_MS,
      bodyTimeout: config.HTTP_TIMEOUT_MS,
      maxRedirections: 0,
      signal,
    });
    const raw = await resp.body.text();
    return {
      status: resp.statusCode,
      body: raw.slice(0, config.MAX_RESPONSE_BODY_BYTES),
      latencyMs: Date.now() - startedAt,
    };
  } catch (err) {
    throw new DeliverError(classify(err), err instanceof Error ? err.message : String(err));
  }
}
