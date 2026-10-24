import { defineConfig, mergeConfig } from 'vitest/config'
import core from './vitest.core.config.ts'

export default mergeConfig(
  core,
  defineConfig({
    test: {
      coverage: {
        provider: 'v8',
        include: ['src/**/*.ts'],
        exclude: ['src/runtime/**', 'src/control/**'],
        reporter: ['text', 'json-summary', 'html'],
        reportsDirectory: 'coverage/core',
      },
    },
  }),
)
