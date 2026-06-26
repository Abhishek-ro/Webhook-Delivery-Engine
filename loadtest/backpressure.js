import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate } from 'k6/metrics';
import { BASE_URL, CLIENT_ID, postParams, uniqueIdemKey } from './lib.js';

const ENDPOINT_ID   = __ENV.ENDPOINT_ID || '';
const BURST_RATE    = parseInt(__ENV.BURST_RATE    || '2000', 10);
const BURST_SECONDS = parseInt(__ENV.BURST_SECONDS || '30',   10);

const responses429  = new Counter('backpressure_429s');
const responses202  = new Counter('backpressure_202s');
const ingestErrors  = new Rate('backpressure_errors');

export const options = {
  scenarios: {
    burst: {
      executor:        'constant-arrival-rate',
      rate:            BURST_RATE,
      timeUnit:        '1s',
      duration:        `${BURST_SECONDS}s`,
      preAllocatedVUs: 500,
      maxVUs:          2000,
    },
    drain: {
      executor:  'constant-vus',
      vus:       10,
      duration:  '90s',
      startTime: `${BURST_SECONDS}s`,
    },
  },

  thresholds: {
    backpressure_429s: ['count>0'],
  },
};

export function setup() {
  if (!ENDPOINT_ID) {
    throw new Error('ENDPOINT_ID env var is required');
  }
  const res = http.get(`${BASE_URL}/healthz`);
  if (res.status !== 200) {
    throw new Error(`Stack not healthy: ${res.status}`);
  }
}

export default function () {
  const body = JSON.stringify({
    client_id:   CLIENT_ID,
    event_type:  'backpressure.probe',
    payload:     { ts: Date.now() },
    endpoint_id: ENDPOINT_ID,
  });

  const params = postParams({ name: 'bp_event' });
  params.headers['Idempotency-Key'] = uniqueIdemKey();

  const res = http.post(`${BASE_URL}/v1/events`, body, params);

  const ok = check(res, {
    '202 or 429': (r) => r.status === 202 || r.status === 200 || r.status === 429,
    '429 has Retry-After': (r) => r.status !== 429 || r.headers['Retry-After'] !== undefined,
  });

  if (res.status === 429) {
    responses429.add(1);
  } else if (res.status === 202 || res.status === 200) {
    responses202.add(1);
  }

  ingestErrors.add(!ok);

  if (res.status === 429) {
    sleep(5);
  }
}

export function teardown() {
  console.log('Backpressure test complete. Verify 429s appeared during burst and 202s resumed after drain.');
}
