import { defineConfig } from 'vitest/config';

// Chaos scenarios kill/pause/restart real containers and sometimes wait out
// real timers measured in tens of seconds (BULLMQ_LOCK_DURATION_MS,
// RECONCILER_GRACE_SECONDS) — much slower and heavier than test:int, and
// not something every `pnpm test` run should pay for. Run serially: two
// scenarios racing to kill/restart the same containers would be
// meaningless.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['test/setup.ts', 'test/chaos/global-setup.ts'],
    include: ['test/chaos/**/*.test.ts'],
    testTimeout: 180_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
