import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { redis } from './client.js';

// Loaded once at boot via SCRIPT LOAD so the hot path (one extend per
// heartbeat tick, one release per delivery, one bucket check per attempt)
// only ever pays for an EVALSHA round trip, not a script-body upload
// (SCHEMA.md §3). If Redis forgets a script — restart, FLUSHALL in a chaos
// test — the next call gets a NOSCRIPT error, reloads once, and retries;
// callers never see that happen.
const scriptsDir = fileURLToPath(new URL('./scripts', import.meta.url));

function loadSource(filename: string): string {
  return readFileSync(path.join(scriptsDir, filename), 'utf8');
}

function isNoScriptError(err: unknown): boolean {
  return err instanceof Error && err.message.includes('NOSCRIPT');
}

/** One script, tracked by its own SHA, reloaded on demand if Redis forgets it. */
class LoadedScript {
  private sha: string | undefined;
  private readonly ready: Promise<void>;

  constructor(private readonly source: string) {
    this.ready = (async () => {
      this.sha = (await redis.script('LOAD', this.source)) as string;
    })();
  }

  async eval(keys: string[], args: Array<string | number>): Promise<number> {
    await this.ready;
    try {
      return (await redis.evalsha(this.sha!, keys.length, ...keys, ...args)) as number;
    } catch (err) {
      if (!isNoScriptError(err)) throw err;
      this.sha = (await redis.script('LOAD', this.source)) as string;
      return (await redis.evalsha(this.sha, keys.length, ...keys, ...args)) as number;
    }
  }
}

const releaseLockScript = new LoadedScript(loadSource('release_lock.lua'));
const extendLockScript = new LoadedScript(loadSource('extend_lock.lua'));
const tokenBucketScript = new LoadedScript(loadSource('token_bucket.lua'));

export async function evalReleaseLock(key: string, token: string): Promise<number> {
  return releaseLockScript.eval([key], [token]);
}

export async function evalExtendLock(key: string, token: string, ttlMs: number): Promise<number> {
  return extendLockScript.eval([key], [token, ttlMs]);
}

export async function evalTokenBucket(
  key: string,
  maxTokens: number,
  ttlSeconds: number,
): Promise<number> {
  return tokenBucketScript.eval([key], [maxTokens, ttlSeconds]);
}
