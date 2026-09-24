import { defineConfig } from 'vitest/config'

const SCRATCH = '/home/ROXY/code/bb_work/r1-supplemental-2026-09-24/evidence/review/scratch'

/**
 * Reviewer's own runner (2026-09-24, R1 supplemental independent review).
 *
 * Every spec here is scratch: it either probes the frozen criteria module for
 * evasion routes, or runs a **copy** of the criteria module + spec with one rule
 * mutated out, to show whether the frozen tests are load-bearing. The originals
 * under `driver/`, `fixtures/` and the historical evidence tree are never
 * touched. No model, no network, no credential.
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
      `${SCRATCH}/probes/*.spec.ts`,
      `${SCRATCH}/mutants/*/s3-criteria.spec.ts`,
      `${SCRATCH}/mutants/*/r1-wiring.spec.ts`,
      `${SCRATCH}/cases/*.spec.ts`,
    ],
    environment: 'node',
    hookTimeout: 120_000,
    testTimeout: 300_000,
    fileParallelism: false,
    reporters: ['default'],
  },
})
