import { defineConfig } from 'vitest/config'

/**
 * The R1 driver's runner for the S2/S3 round (2026-09-23, operator-authorized
 * continuation). The driver lives in scratch, outside the repository: its
 * imports are rewritten to the real harness tree, and this config points the
 * repository's TypeScript pipeline at it from the repository root so `vitest`
 * and every workspace dependency resolve exactly as they did for S1.
 */
export default defineConfig({
  root: '/home/ROXY/code/bb_work/harness',
  server: {
    fs: {
      allow: ['/home/ROXY/code/bb_work/harness', '/home/ROXY/code/bb_work/r1-scratch'],
    },
  },
  test: {
    include: ['/home/ROXY/code/bb_work/r1-scratch/s2/**/*.spec.ts'],
    environment: 'node',
    hookTimeout: 120_000,
    testTimeout: 900_000,
    fileParallelism: false,
    reporters: ['default'],
  },
})
