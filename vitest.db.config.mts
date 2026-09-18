import { defineConfig } from 'vitest/config'

/**
 * The database suite, kept apart from `pnpm test` on purpose: cloning this repo and running
 * the tests should work before you have started anything.
 *
 * `pnpm test`     — pure, fast, no Docker.
 * `pnpm test:db`  — needs `docker compose up -d postgres`.
 */
export default defineConfig({
  test: {
    include: ['tests/db/**/*.db.test.ts'],
    globalSetup: ['tests/db/setup.ts'],
    setupFiles: ['tests/db/setup-env.ts'],
    // One file at a time. The concurrency these tests are about comes from several
    // connections inside a single test, not from Vitest running files in parallel — and
    // parallel files sharing one database would step on each other's tables.
    fileParallelism: false,
    // A deadlocked or blocked query should fail the test, not hang the suite.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
