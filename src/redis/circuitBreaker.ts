import { redis } from './client.js';
import { config } from '../shared/config.js';

// Lifecycle (ARCHITECTURE.md §4 — written out because the implicit version
// bites):
//   1. Closed: every failed delivery attempt INCRs `:fails` (EXPIRE 300s).
//      Count >= CB_FAIL_THRESHOLD -> SET `:open` EX CB_OPEN_SECONDS.
//   2. Open: workers fail fast with CIRCUIT_OPEN, never touching the
//      endpoint.
//   3. Half-open: `:open` expiring *is* the half-open state — no separate
//      timer. The next worker in does `SET :probe NX EX CB_PROBE_SECONDS`;
//      the winner sends the one real request, losers still fail fast.
//   4. Probe succeeds -> DEL :fails, DEL :probe; fully closed, count zeroed.
//   5. Probe fails -> immediately re-SET :open (no waiting for 20 failures
//      again — the endpoint already proved itself sick) + DEL :probe.
//
// None of this needs Lua: the only step that has to be race-free is "exactly
// one worker wins the probe", and a plain SET NX already gives us that
// atomically. Everything else tolerates the ordinary small races of
// separate GET/SET calls.

export type BreakerState = 'closed' | 'open' | 'probe';

function failsKey(endpointId: string): string {
  return `wh:cb:${endpointId}:fails`;
}
function openKey(endpointId: string): string {
  return `wh:cb:${endpointId}:open`;
}
function probeKey(endpointId: string): string {
  return `wh:cb:${endpointId}:probe`;
}

/** Call after a real (non-LOCK_LOST) delivery failure. May flip the breaker open. */
export async function recordFailure(endpointId: string): Promise<void> {
  const fails = await redis.incr(failsKey(endpointId));
  await redis.expire(failsKey(endpointId), config.CB_WINDOW_SECONDS);

  if (fails >= config.CB_FAIL_THRESHOLD) {
    await redis.set(openKey(endpointId), '1', 'EX', config.CB_OPEN_SECONDS);
  }
}

export async function checkState(endpointId: string): Promise<BreakerState> {
  const isOpen = await redis.exists(openKey(endpointId));
  if (isOpen) return 'open';

  const fails = await redis.get(failsKey(endpointId));
  if (fails !== null && Number(fails) >= config.CB_FAIL_THRESHOLD) {
    // `:open` has expired but the failure count never got cleared — this is
    // the half-open window. SET NX atomically elects exactly one probe
    // winner; everyone else still fails fast this round.
    const wonProbe = await redis.set(probeKey(endpointId), '1', 'EX', config.CB_PROBE_SECONDS, 'NX');
    return wonProbe === 'OK' ? 'probe' : 'open';
  }

  return 'closed';
}

/** Call once after the single probe request's outcome is known. */
export async function onProbeResult(endpointId: string, ok: boolean): Promise<void> {
  if (ok) {
    await redis.del(failsKey(endpointId), probeKey(endpointId));
  } else {
    await redis.set(openKey(endpointId), '1', 'EX', config.CB_OPEN_SECONDS);
    await redis.del(probeKey(endpointId));
  }
}
