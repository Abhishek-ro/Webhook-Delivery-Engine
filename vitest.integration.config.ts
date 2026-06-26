import { defineConfig } from 'vitest/config';

// "Integration" project: hits real Postgres + Redis (see test/setup.ts for
// connection defaults) and sometimes real timing (retry/backoff windows), so
// it gets a longer per-test timeout and runs files serially — concurrent
// integration files would race on shared DB rows.
//
// hookTimeout is raised from the 10 s default: worker-kill.test.ts runs
// `docker compose up -d worker` in beforeAll, which can take >10 s on Docker
// Desktop (Windows) if a worker container was previously killed and needs to
// be restarted.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['test/setup.ts'],
    include: ['test/integration/**/*.test.ts', 'test/invariants/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
});
