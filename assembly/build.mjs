#!/usr/bin/env node
/**
 * Build the assembly into three loadable modules.
 *
 * The package cannot be shipped as TypeScript. It imports `src/**` with `.ts` specifiers — that is how
 * this repository runs its own tests, through a loader hook — and Node refuses to strip types inside
 * `node_modules`, which is where a profile resolves a bundle from. So the package is **bundled**: one
 * entry file per face, every relative import inlined or emitted once beside them, and every
 * `@deepseek-ai/*` package left external because the host profile provides those at runtime and a copy
 * inside the bundle would be a second cordis.
 *
 * Three entries, because the three faces are mounted at different places in a profile: `lib/index.js`
 * provides the `singularity` service, `lib/agent.js` turns it into tools inside a mounted agent's
 * scope, and `lib/web.js` adds the read route to a profile that has a Web server. The Web row is
 * separate so a profile without one mounts the package rather than a plugin that activates and then
 * cannot find the seam it declares. `package.json` maps them to `.`, `./agent` and `./web`.
 *
 * The panel's client bundle is deliberately **not** an entry here: the host reads that file verbatim
 * and there is no bundler at runtime, so the file in the tree is the artifact
 * (`docs/phase-g2-design.md` §4).
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
        web: join(here, 'src/web.ts'),
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

console.log('assembly: built lib/index.js, lib/agent.js and lib/web.js')
