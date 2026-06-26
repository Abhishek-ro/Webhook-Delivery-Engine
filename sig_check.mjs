import { sign, verify } from './src/worker/signature.ts';

const secret = 'whsec_test_abc123';
const ts = 1781430000;
const body = '{"event_id":"evt_1","data":{"amount_cents":4200}}';

const sigHex = sign(secret, ts, body);
console.log('sign ok, len=', sigHex.length);
console.log('verify same inputs:', verify(secret, ts, body, sigHex));
console.log('verify tampered body:', verify(secret, ts, '{"x":1}', sigHex));
console.log('verify tampered ts:', verify(secret, ts + 1, body, sigHex));
console.log('verify wrong secret:', verify('other', ts, body, sigHex));
console.log('verify malformed hex:', verify(secret, ts, body, 'not-hex'));
