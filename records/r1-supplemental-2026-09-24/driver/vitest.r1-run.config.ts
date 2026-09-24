import { defineConfig } from 'vitest/config'

const DRIVER = '/home/ROXY/code/bb_work/r1-supplemental-2026-09-24/driver'

/**
 * The **paid** run of this round: S3's single attempt through the real stack and
 * the production `DeepSeekAdapter` over the configured gateway, plus its one
 * connectivity smoke. This config exists so the attempt is always explicit and
 * never picked up by the deterministic runner:
 *
 *   cd /home/ROXY/code/bb_work/harness && pnpm exec vitest run \
 *     --config /home/ROXY/code/bb_work/r1-supplemental-2026-09-24/driver/vitest.r1-run.config.ts
 *
 * Running it costs a real model call; `r1-s3.spec.ts` archives its evidence
 * under `<workdir>/evidence/{smoke-1,s3}/` and computes no verdict — the frozen
 * criteria decide afterwards.
 */
export default defineConfig({
  root: '/home/ROXY/code/bb_work/harness',
  server: {
    fs: {
      allow: ['/home/ROXY/code/bb_work/harness', '/home/ROXY/code/bb_work/r1-supplemental-2026-09-24'],
    },
  },
  test: {
    include: [`${DRIVER}/r1-s3.spec.ts`],
    environment: 'node',
    hookTimeout: 120_000,
    testTimeout: 900_000,
    fileParallelism: false,
    reporters: ['default'],
  },
})
