import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';
import { BASE_URL, buildEventBody, postParams } from './lib.js';

const errorRate   = new Rate('event_post_errors');
const ingestTrend = new Trend('event_post_duration', true);

export const options = {
  scenarios: {
    baseline: {
      executor:         'ramping-vus',
      startVUs:         0,
      stages: [
        { duration: '5m',  target: 2000 },
        { duration: '10m', target: 2000 },
        { duration: '30s', target: 0    },
      ],
      gracefulRampDown: '30s',
    },
  },

  thresholds: {
    'http_req_duration{scenario:baseline}': ['p(95)<500'],
    'http_req_failed{scenario:baseline}':   ['rate<0.01'],
    event_post_duration: ['p(95)<500'],
    event_post_errors:   ['rate<0.01'],
  },
};

export function setup() {
  // tsx takes ~10s to compile on first boot; retry for up to 60s
  let res;
  for (let i = 0; i < 30; i++) {
    res = http.get(`${BASE_URL}/healthz`);
    if (res.status === 200) break;
    console.log(`Waiting for stack... attempt ${i + 1}/30 (status=${res.status})`);
    sleep(2);
  }
  if (!res || res.status !== 200) {
    throw new Error(`Healthcheck failed after 30 attempts (${res ? res.status : 'no response'}): ${res ? res.body : 'null'}`);
  }
  console.log(`Stack healthy — starting baseline against ${BASE_URL}`);
}

export default function () {
  const body   = buildEventBody('payment.completed', { amount: 100, currency: 'USD' });
  const params = postParams({ name: 'post_event' });

  const res = http.post(`${BASE_URL}/v1/events`, body, params);

  const ok = check(res, {
    'status is 2xx': (r) => r.status >= 200 && r.status < 300,
    'has delivery_id': (r) => {
      try {
        const j = JSON.parse(r.body);
        return typeof j.delivery_id === 'string' || typeof j.id === 'string';
      } catch {
        return false;
      }
    },
  });

  errorRate.add(!ok);
  ingestTrend.add(res.timings.duration);
  sleep(1);
}

export function teardown() {
  console.log('Baseline test complete. Run scripts/zero-loss.sh to verify no events were lost.');
}
