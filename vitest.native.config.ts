import { defineConfig } from 'vitest/config'
import configuredHost from './vitest.config.ts'
import { nativeTests } from './scripts/test-groups.mjs'

export default defineConfig({ ...configuredHost, test: { ...configuredHost.test, include: nativeTests } })
