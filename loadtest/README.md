# Load Tests

Three k6 scripts in this directory, one Makefile workflow.

## Setup

```bash
make loadtest-up      # boots stack with CPU-pinned overrides
make migrate          # idempotent

EP=$(curl -sf -X POST http://localhost:3000/v1/endpoints \
  -H 'Content-Type: application/json' \
  -d '{"client_id":"loadtest","url":"http://test-receiver:4000/ok"}' \
  | jq -r .id)
```

## Scripts

**baseline.js** — ramp 0→2000 VUs over 5 min, hold 10 min. Thresholds: p(95) < 500 ms, error rate < 1%.

**abuse.js** — same load against a receiver pre-set to 30% HTTP 500 + 5% timeouts. Validates retry math.

**saturation.js** — steps VUs 500→4000 in 2-min holds. No threshold — goal is finding the breaking point.

## Running

```bash
make loadtest-baseline ENDPOINT_ID=$EP      # baseline run + lag + zero-loss
make loadtest-lag                           # p50/p95/p99 delivery lag from Postgres
make loadtest-zero-loss                     # k6 iteration count == events table count

make loadtest-abuse                         # abuse run
make loadtest-expectation                   # validate retry math (within ±5%)

make loadtest-saturation ENDPOINT_ID=$EP   # step VUs to find break
make loadtest-pools                         # pgBouncer pool utilisation (separate terminal)
```

## Results

Raw output lands in `loadtest/results/{date}/`. Numbers get summarised in `LOADTEST.md` at the repo root.
