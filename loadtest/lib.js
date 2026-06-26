import { uuidv4 } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';

export const BASE_URL    = __ENV.BASE_URL    || 'http://localhost:3000';
export const ENDPOINT_ID = __ENV.ENDPOINT_ID || '';
export const CLIENT_ID   = __ENV.CLIENT_ID   || 'loadtest';

if (!ENDPOINT_ID) {
  console.error('ENDPOINT_ID env var is required');
}

export function uniqueIdemKey() {
  return `${__VU}-${__ITER}-${uuidv4()}`;
}

export function buildEventBody(eventType, payload) {
  return JSON.stringify({
    client_id:   CLIENT_ID,
    event_type:  eventType,
    payload:     payload ?? { ts: Date.now() },
    endpoint_id: ENDPOINT_ID,
  });
}

export const JSON_HEADERS = {
  'Content-Type': 'application/json',
  'Idempotency-Key': '',
};

export function postParams(tags) {
  return {
    headers: {
      'Content-Type':    'application/json',
      'Idempotency-Key': uniqueIdemKey(),
    },
    tags: tags ?? {},
  };
}
