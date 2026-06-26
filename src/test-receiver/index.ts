import express from 'express';
import type { Request } from 'express';
import { verify } from '../worker/signature.js';

// Stand-in for a customer's webhook endpoint. Used by integration/chaos
// tests to assert what actually arrived over HTTP — request count, headers,
// signature validity, body — rather than trusting our own DB writes.
//
// All four delivery-shape routes (/ok, /fail/:status, /timeout/:ms,
// /flap/:n) verify the HMAC signature the same way a real customer
// integration would (see README "Receiving webhooks" section, written in
// Week 3) and reject with 401 on a bad signature instead of silently
// accepting it — a receiver that doesn't check the signature isn't a
// faithful stand-in.

const PORT = Number(process.env['PORT'] ?? 4000);
const SIGNING_SECRET = process.env['TEST_RECEIVER_SECRET'] ?? 'whsec_test_receiver_secret';

export interface LoggedRequest {
  id: string | null;
  attempt: number | null;
  ts: number | null;
  path: string;
  body: unknown;
  validSignature: boolean;
  receivedAt: string;
}

const requestLog: LoggedRequest[] = [];
// Per-delivery counter for /flap/:n — keyed by X-Webhook-Id, not by
// jobId/attempt, so it survives across BullMQ retries of the same delivery.
const flapCounts = new Map<string, number>();

// /chaos knobs — module-level state, not per-request, because the same
// registered endpoint URL is hit by every retry of every delivery in a
// chaos scenario; the knobs need to persist across all of them until
// /_reset clears them, not just affect the one request that happened to
// carry the query string.
interface ChaosConfig {
  errorRate: number;
  timeoutRate: number;
  slowDripMs: number;
}
let chaosConfig: ChaosConfig = { errorRate: 0, timeoutRate: 0, slowDripMs: 0 };

function queryNumber(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

const app = express();
// Raw bytes, not re-parsed JSON: the signature was computed over the exact
// bytes the worker sent, and JSON.stringify(JSON.parse(body)) is not
// guaranteed to reproduce them (key order, whitespace). Verify against the
// wire bytes, parse a copy afterward only for logging/assertions.
app.use(express.raw({ type: '*/*', limit: '2mb' }));

function logRequest(req: Request): LoggedRequest {
  const rawBody = req.body as Buffer;
  const idHeader = req.header('x-webhook-id') ?? null;
  const attemptHeader = req.header('x-webhook-attempt');
  const tsHeader = req.header('x-webhook-timestamp');
  const sigHeader = req.header('x-webhook-signature') ?? '';
  const sigHex = sigHeader.startsWith('sha256=') ? sigHeader.slice('sha256='.length) : sigHeader;

  let validSignature = false;
  if (idHeader && tsHeader && sigHex) {
    try {
      validSignature = verify(SIGNING_SECRET, Number(tsHeader), rawBody.toString('utf8'), sigHex);
    } catch {
      validSignature = false;
    }
  }

  let parsedBody: unknown = null;
  if (rawBody.length > 0) {
    try {
      parsedBody = JSON.parse(rawBody.toString('utf8'));
    } catch {
      parsedBody = rawBody.toString('utf8');
    }
  }

  const entry: LoggedRequest = {
    id: idHeader,
    attempt: attemptHeader ? Number(attemptHeader) : null,
    ts: tsHeader ? Number(tsHeader) : null,
    path: req.path,
    body: parsedBody,
    validSignature,
    receivedAt: new Date().toISOString(),
  };
  requestLog.push(entry);
  return entry;
}

app.post('/ok', (req, res) => {
  const entry = logRequest(req);
  if (!entry.validSignature) {
    res.status(401).json({ error: 'invalid_signature' });
    return;
  }
  res.status(200).json({ ok: true });
});

app.post('/fail/:status', (req, res) => {
  const entry = logRequest(req);
  if (!entry.validSignature) {
    res.status(401).json({ error: 'invalid_signature' });
    return;
  }
  const status = Number(req.params['status']) || 500;
  res.status(status).json({ failed: true, status });
});

app.post('/timeout/:ms', (req, res) => {
  const entry = logRequest(req);
  if (!entry.validSignature) {
    res.status(401).json({ error: 'invalid_signature' });
    return;
  }
  const delayMs = Number(req.params['ms']) || 0;
  setTimeout(() => {
    res.status(200).json({ ok: true, delayedMs: delayMs });
  }, delayMs);
});

app.post('/flap/:n', (req, res) => {
  const entry = logRequest(req);
  if (!entry.validSignature) {
    res.status(401).json({ error: 'invalid_signature' });
    return;
  }
  const failuresBeforeSuccess = Number(req.params['n']) || 0;
  const key = entry.id ?? 'unknown';
  const priorFailures = flapCounts.get(key) ?? 0;

  if (priorFailures < failuresBeforeSuccess) {
    flapCounts.set(key, priorFailures + 1);
    res.status(503).json({ failed: true, failureNumber: priorFailures + 1, of: failuresBeforeSuccess });
    return;
  }

  res.status(200).json({ ok: true, recoveredAfterFailures: priorFailures });
});

// Chaos endpoint: error_rate (0-1) and timeout_rate (0-1) are rolled
// independently against the same draw, so a 0.3 error_rate + 0.05
// timeout_rate means ~35% of requests misbehave, ~5 percentage points of
// which never respond at all. slow_drip_ms, if set (and neither error nor
// timeout was rolled), writes the body in a few chunks spread over that
// many milliseconds before resolving 200 — for exercising bodyTimeout
// rather than headersTimeout. Query params update the persisted knobs;
// omitting a param leaves its current value alone, so the same registered
// URL keeps behaving consistently across every retry of every delivery.
app.post('/chaos', (req, res) => {
  const entry = logRequest(req);
  if (!entry.validSignature) {
    res.status(401).json({ error: 'invalid_signature' });
    return;
  }

  chaosConfig = {
    errorRate: queryNumber(req.query['error_rate']) ?? chaosConfig.errorRate,
    timeoutRate: queryNumber(req.query['timeout_rate']) ?? chaosConfig.timeoutRate,
    slowDripMs: queryNumber(req.query['slow_drip_ms']) ?? chaosConfig.slowDripMs,
  };

  const roll = Math.random();
  if (roll < chaosConfig.timeoutRate) {
    return; // never respond — the client's own HTTP_TIMEOUT_MS is what ends this
  }
  if (roll < chaosConfig.timeoutRate + chaosConfig.errorRate) {
    res.status(500).json({ chaos: 'error_rate' });
    return;
  }

  if (chaosConfig.slowDripMs > 0) {
    const CHUNKS = 4;
    res.status(200);
    let sent = 0;
    const timer = setInterval(() => {
      res.write(JSON.stringify({ chunk: sent }));
      sent += 1;
      if (sent >= CHUNKS) {
        clearInterval(timer);
        res.end();
      }
    }, chaosConfig.slowDripMs / CHUNKS);
    return;
  }

  res.status(200).json({ ok: true });
});

app.get('/_requests', (req, res) => {
  const webhookId = req.query['webhook_id'];
  const filtered =
    typeof webhookId === 'string' ? requestLog.filter((r) => r.id === webhookId) : requestLog;
  res.status(200).json({ requests: filtered });
});

app.post('/_reset', (_req, res) => {
  requestLog.length = 0;
  flapCounts.clear();
  chaosConfig = { errorRate: 0, timeoutRate: 0, slowDripMs: 0 };
  res.status(200).json({ reset: true });
});

app.listen(PORT, () => {
  console.log(`[test-receiver] listening on :${PORT}`);
});
