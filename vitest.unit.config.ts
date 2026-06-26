import { defineConfig } from 'vitest/config';

// "Unit" project: no live Postgres/Redis required — pure logic + fully-mocked
// API tests. Kept on vitest's default per-test timeout.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['test/setup.ts'],
    include: ['test/unit/**/*.test.ts', 'test/api/**/*.test.ts', 'test/config.invariants.test.ts'],
  },
});
