import { defineConfig } from 'vitest/config'
import { nativeTests } from './scripts/test-groups.mjs'

export default defineConfig({
  test: {
    maxWorkers: 1,
    include: ['tests/**/*.spec.ts'],
    exclude: nativeTests,
  },
})
