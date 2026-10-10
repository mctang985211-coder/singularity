#!/usr/bin/env node
/**
 * Build the assembly into two loadable modules.
 *
 * The package cannot be shipped as TypeScript. It imports `src/**` with `.ts` specifiers — that is how
 * this repository runs its own tests, through a loader hook — and Node refuses to strip types inside
 * `node_modules`, which is where a profile resolves a bundle from. So the package is **bundled**: one
 * entry file per face, every relative import inlined or emitted once beside them, and every
 * `@deepseek-ai/*` package left external because the host profile provides those at runtime and a copy
 * inside the bundle would be a second cordis.
 *
 * Two entries, because the host plugin and the agent face are mounted at different places in a
 * profile: `lib/index.js` provides the `singularity` service, `lib/agent.js` turns it into tools
 * inside a mounted agent's scope. `package.json` maps them to `.` and `./agent`.
 *
 * The bundler is `vite`, a devDependency of this repository, resolved through the ordinary module
 * graph. A checkout with no `node_modules` fails here with Node's own `ERR_MODULE_NOT_FOUND`, which
 * names the package that is missing.
 *
 * Usage: node assembly/build.mjs
 *
 * @module singularity-core/assembly/build
 */

import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { build } from 'vite'

const here = dirname(fileURLToPath(import.meta.url))

await build({
  configFile: false,
  root: here,
  logLevel: 'warn',
  build: {
    outDir: join(here, 'lib'),
    emptyOutDir: true,
    minify: false,
    target: 'node22',
    lib: {
      entry: {
        index: join(here, 'src/index.ts'),
        agent: join(here, 'src/agent.ts'),
      },
      formats: ['es'],
      fileName: (_format, entryName) => `${entryName}.js`,
    },
    rollupOptions: {
      // The host profile provides every DSH package. Bundling one would give the process a second
      // cordis and a second service registry, which is the one thing an assembly must not do. Node's
      // own modules are external too: a browser-compatibility stub for `node:fs` is a module that
      // silently does nothing, and an assembly that reads no file cannot build a workspace.
      external: id => id.startsWith('@deepseek-ai/') || id.startsWith('node:'),
    },
  },
})

console.log('assembly: built lib/index.js and lib/agent.js')
