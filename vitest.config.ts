/**
 * Vitest resolution for the DSH packages our code imports.
 *
 * The packages are declared as peer dependencies and are never installed: the host DSH profile
 * provides them at runtime, and `tsconfig.json`'s `paths` resolves them for `tsc`. Vitest resolves
 * modules itself, so it needs the same mapping to reach the installed 0.2.0-rc.2 build. Nothing
 * here fetches anything; it points at the build already on this machine.
 */
import { defineConfig } from 'vitest/config'

const DSH_INSTALLED = '/home/ROXY/.local/node-v22.23.3-linux-x64/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'

export default defineConfig({
  resolve: {
    alias: {
      '@deepseek-ai/cordis': `${DSH_INSTALLED}/cordis/lib/index.js`,
      '@deepseek-ai/dsh-session': `${DSH_INSTALLED}/dsh-session/lib/index.js`,
      '@deepseek-ai/dsh-session-persistence': `${DSH_INSTALLED}/dsh-session-persistence/lib/index.js`,
      '@deepseek-ai/dsh-session-persistence-jsonl': `${DSH_INSTALLED}/dsh-session-persistence-jsonl/lib/index.js`,
      '@deepseek-ai/dsh-agent': `${DSH_INSTALLED}/dsh-agent/lib/index.js`,
      '@deepseek-ai/dsh-agent-loop': `${DSH_INSTALLED}/dsh-agent-loop/lib/index.js`,
      '@deepseek-ai/dsh-user-approval': `${DSH_INSTALLED}/dsh-user-approval/lib/index.js`,
    },
  },
})
