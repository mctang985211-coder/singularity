/**
 * Vitest resolution for the DSH packages our code imports, and the one test run for both packages.
 *
 * The DSH packages are declared as peer dependencies and are never installed: the host DSH profile
 * provides them at runtime, and each package's `tsconfig.json` resolves them for `tsc`. Vitest
 * resolves modules itself, so it needs the same mapping — pointed at the private 0.2.0-rc.2 install
 * this deployment boots (`$DSH_CONTROL_INSTALLED`, exported by that environment's `env.sh`), never at
 * a registry and never at the global install, which is a different build. Nothing here fetches
 * anything.
 *
 * `assembly/tests` runs in this same run: the assembly is part of the stack, and a separate command
 * for its specs is a suite that can be forgotten.
 */
import { defineConfig } from 'vitest/config'

const DSH_INSTALLED =
  process.env['DSH_CONTROL_INSTALLED'] ?? '/home/ROXY/singularity-next/dsh/node_modules/@deepseek-ai'

export default defineConfig({
  resolve: {
    alias: {
      '@deepseek-ai/cordis': `${DSH_INSTALLED}/cordis/lib/index.js`,
      '@deepseek-ai/dsh-session': `${DSH_INSTALLED}/dsh-session/lib/index.js`,
      '@deepseek-ai/dsh-session-persistence': `${DSH_INSTALLED}/dsh-session-persistence/lib/index.js`,
      '@deepseek-ai/dsh-session-persistence-jsonl': `${DSH_INSTALLED}/dsh-session-persistence-jsonl/lib/index.js`,
      '@deepseek-ai/dsh-agent': `${DSH_INSTALLED}/dsh-agent/lib/index.js`,
      '@deepseek-ai/dsh-agent-loop': `${DSH_INSTALLED}/dsh-agent-loop/lib/index.js`,
      '@deepseek-ai/dsh-tools': `${DSH_INSTALLED}/dsh-tools/lib/index.js`,
      '@deepseek-ai/dsh-user-approval': `${DSH_INSTALLED}/dsh-user-approval/lib/index.js`,
      '@deepseek-ai/schemastery': `${DSH_INSTALLED}/schemastery/lib/index.mjs`,
    },
  },
  test: {
    include: ['tests/**/*.spec.ts', 'assembly/tests/**/*.spec.ts'],
  },
})
