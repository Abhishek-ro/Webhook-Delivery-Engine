import http from 'k6/http';
import { check } from 'k6';
import { Trend, Rate } from 'k6/metrics';
import { BASE_URL, ENDPOINT_ID, CLIENT_ID, postParams, uniqueIdemKey } from './lib.js';

const reqDuration = new Trend('saturation_req_duration', true);
const reqErrors   = new Rate('saturation_req_errors');

export const options = {
  scenarios: {
    saturation: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '1m',  target: 500  },
        { duration: '2m',  target: 500  },
        { duration: '1m',  target: 1000 },
        { duration: '2m',  target: 1000 },
        { duration: '1m',  target: 2000 },
        { duration: '2m',  target: 2000 },
        { duration: '1m',  target: 3000 },
        { duration: '2m',  target: 3000 },
        { duration: '1m',  target: 4000 },
        { duration: '2m',  target: 4000 },
        { duration: '30s', target: 0    },
      ],
      gracefulRampDown: '30s',
    },
  },

  thresholds: {
    saturation_req_errors: ['rate<0.20'],
  },
};

function vuBucket() {
  if (__VU <= 500)  return '0500';
  if (__VU <= 1000) return '1000';
  if (__VU <= 2000) return '2000';
  if (__VU <= 3000) return '3000';
  return '4000';
}

export function setup() {
  if (!ENDPOINT_ID) {
    throw new Error('ENDPOINT_ID env var is required for saturation test.');
  }
  const res = http.get(`${BASE_URL}/healthz`);
  if (res.status !== 200) {
    throw new Error(`Stack not healthy: ${res.status}`);
  }
  console.log(`Saturation test starting against ${BASE_URL} (ENDPOINT_ID=${ENDPOINT_ID})`);
}

export default function () {
  const bucket = vuBucket();

  const body = JSON.stringify({
    client_id:   CLIENT_ID,
    event_type:  'saturation.probe',
    payload:     { ts: Date.now(), vu: __VU, bucket },
    endpoint_id: ENDPOINT_ID,
  });

  const params = postParams({ name: 'saturation_event', vu_bucket: bucket });
  params.headers['Idempotency-Key'] = uniqueIdemKey();

  const res = http.post(`${BASE_URL}/v1/events`, body, params);

  const ok = check(res, {
    'status 2xx': (r) => r.status >= 200 && r.status < 300,
  });

  reqDuration.add(res.timings.duration, { vu_bucket: bucket });
  reqErrors.add(!ok, { vu_bucket: bucket });
}

export function teardown() {
  console.log('Saturation test complete. Check loadtest/summary.json for per-bucket p95 values.');
  console.log('The saturation point is the last vu_bucket where p95 < 500ms. Record in LOADTEST.md.');
}
