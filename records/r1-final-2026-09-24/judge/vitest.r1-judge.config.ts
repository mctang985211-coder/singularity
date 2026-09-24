import { defineConfig } from 'vitest/config'

const JUDGE = '/home/ROXY/code/bb_work/r1-final-2026-09-24/judge'

/** The deterministic, model-free judging run of the completion round. */
export default defineConfig({
  root: '/home/ROXY/code/bb_work/harness',
  server: {
    fs: {
      allow: ['/home/ROXY/code/bb_work/harness', '/home/ROXY/code/bb_work/r1-final-2026-09-24'],
    },
  },
  test: {
    include: [`${JUDGE}/judge.spec.ts`],
    environment: 'node',
    fileParallelism: false,
    reporters: ['default'],
  },
})
