import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate } from 'k6/metrics';
import { BASE_URL, CLIENT_ID, postParams, uniqueIdemKey } from './lib.js';

const RECEIVER_URL = __ENV.RECEIVER_URL || 'http://test-receiver:4000';
const CHAOS_URL    = `${RECEIVER_URL}/chaos?error_rate=0.30&timeout_rate=0.05`;

const ingestErrors = new Rate('abuse_ingest_errors');

export const options = {
  scenarios: {
    abuse: {
      executor:    'ramping-vus',
      startVUs:    0,
      stages: [
        { duration: '2m',  target: 200 },
        { duration: '5m',  target: 200 },
        { duration: '30s', target: 0   },
      ],
      gracefulRampDown: '30s',
    },
  },

  thresholds: {
    'http_req_duration{scenario:abuse}': ['p(95)<500'],
    'http_req_failed{scenario:abuse}':   ['rate<0.01'],
    abuse_ingest_errors:                 ['rate<0.01'],
  },
};

export function setup() {
  const res = http.post(
    `${BASE_URL}/v1/endpoints`,
    JSON.stringify({
      client_id:      CLIENT_ID,
      url:            CHAOS_URL,
      signing_secret: 'whsec_test_receiver_secret',
    }),
    { headers: { 'Content-Type': 'application/json' } },
  );

  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Failed to create chaos endpoint (${res.status}): ${String(res.body)}`);
  }

  const endpoint = JSON.parse(String(res.body));
  console.log(`Chaos endpoint created: ${String(endpoint.id)} → ${CHAOS_URL}`);
  return { endpointId: String(endpoint.id) };
}

export default function (data) {
  const endpointId = data.endpointId;

  const body = JSON.stringify({
    client_id:   CLIENT_ID,
    event_type:  'abuse.test',
    payload:     { ts: Date.now(), vu: __VU },
    endpoint_id: endpointId,
  });

  const params = postParams({ name: 'abuse_ingest' });
  params.headers['Idempotency-Key'] = uniqueIdemKey();

  const res = http.post(`${BASE_URL}/v1/events`, body, params);

  const ok = check(res, {
    'ingest 2xx': (r) => r.status >= 200 && r.status < 300,
  });

  ingestErrors.add(!ok);
  sleep(0.5);
}

export function teardown(data) {
  console.log(`Abuse test complete. Endpoint ${String(data.endpointId)} left in place for retry inspection.`);
  console.log('Run scripts/expectation.sql to validate retry math.');
}
