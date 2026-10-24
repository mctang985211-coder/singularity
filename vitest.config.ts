/** One deterministic suite using the explicitly configured private DSH host. */
import { defineConfig } from 'vitest/config'
import { hostFindings, hostInstall, hostRequire } from './scripts/host-config.mjs'

const installed = hostInstall()
const findings = hostFindings(installed)
if (findings.length) throw new Error(findings.join('\n'))
const host = hostRequire(installed)

export default defineConfig({
  plugins: [
    {
      name: 'private-dsh-host',
      enforce: 'pre',
      resolveId(id) {
        if (id.startsWith('@deepseek-ai/')) return host.resolve(id)
      },
    },
  ],
  test: {
    maxWorkers: 1,
    include: ['tests/**/*.spec.ts', 'assembly/tests/**/*.spec.ts'],
  },
})
