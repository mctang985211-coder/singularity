import { defineConfig } from 'vitest/config'

const CRITERIA = '/home/ROXY/code/bb_work/r1-rework-2026-09-24/criteria'

/**
 * The R1 rework round's runner for the **deterministic** criteria specs
 * (2026-09-24): the two counterexamples for `s3-criteria/2`
 * (`s3-criteria-rev2.spec.ts`), the verdict matrix over both criteria versions
 * (`verdict-matrix.spec.ts`) and the real-wiring positive case
 * (`rev2-wiring.spec.ts`).
 *
 * No paid model, no gateway, no network: the first two specs replay archived
 * records and mutate them in memory, and the wiring spec runs the real stack
 * with a scripted provider so that only the model's own output stands in. The
 * paid attempt of the previous round is deliberately **not** in this list; its
 * record is read back read-only.
 *
 *   cd /home/ROXY/code/bb_work/harness && pnpm exec vitest run \
 *     --config /home/ROXY/code/bb_work/r1-rework-2026-09-24/criteria/vitest.rev2.config.ts
 */
export default defineConfig({
  root: '/home/ROXY/code/bb_work/harness',
  server: {
    fs: {
      allow: [
        '/home/ROXY/code/bb_work/harness',
        '/home/ROXY/code/bb_work/r1-rework-2026-09-24',
        '/home/ROXY/code/bb_work/r1-supplemental-2026-09-24',
      ],
    },
  },
  test: {
    include: [
      `${CRITERIA}/s3-criteria-rev2.spec.ts`,
      `${CRITERIA}/verdict-matrix.spec.ts`,
      `${CRITERIA}/rev2-wiring.spec.ts`,
    ],
    exclude: ['**/node_modules/**'],
    environment: 'node',
    hookTimeout: 120_000,
    testTimeout: 900_000,
    fileParallelism: false,
    reporters: ['default'],
  },
})
