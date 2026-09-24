import { defineConfig } from 'vitest/config'

const DRIVER = '/home/ROXY/code/bb_work/r1-supplemental-2026-09-24/driver'

/**
 * The R1 supplemental driver's runner for the **deterministic** specs
 * (2026-09-24, Q4/Q5 round): the frozen criteria (`s3-criteria.spec.ts`) and the
 * criteria/fixture wiring (`r1-wiring.spec.ts`). Both make no paid model call
 * and no network request; the wiring spec runs the real stack with a scripted
 * provider, and only the model's own answers are scripted.
 *
 * The driver lives in scratch, outside the repository: its imports are written
 * against the real harness tree, and this config points the repository's
 * TypeScript pipeline at it from the repository root so `vitest` and every
 * workspace dependency resolve exactly as the in-repo suites do.
 *
 * The paid run is deliberately **not** in this list: `r1-s3.spec.ts` is the one
 * real attempt and is run explicitly through `vitest.r1-run.config.ts`.
 *
 *   cd /home/ROXY/code/bb_work/harness && pnpm exec vitest run \
 *     --config /home/ROXY/code/bb_work/r1-supplemental-2026-09-24/driver/vitest.r1.config.ts
 */
export default defineConfig({
  root: '/home/ROXY/code/bb_work/harness',
  server: {
    fs: {
      allow: ['/home/ROXY/code/bb_work/harness', '/home/ROXY/code/bb_work/r1-supplemental-2026-09-24'],
    },
  },
  test: {
    include: [
      `${DRIVER}/s3-criteria.spec.ts`,
      `${DRIVER}/r1-wiring.spec.ts`,
    ],
    exclude: [`${DRIVER}/r1-s3.spec.ts`, '**/node_modules/**'],
    environment: 'node',
    hookTimeout: 120_000,
    testTimeout: 900_000,
    fileParallelism: false,
    reporters: ['default'],
  },
})
