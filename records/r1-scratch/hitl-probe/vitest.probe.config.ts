import { defineConfig } from 'vitest/config'
export default defineConfig({
  root: '/home/ROXY/code/bb_work/harness',
  test: {
    include: ['/home/ROXY/code/bb_work/r1-scratch/hitl-probe/**/*.spec.ts'],
    environment: 'node',
    testTimeout: 120_000,
    fileParallelism: false,
  },
})
