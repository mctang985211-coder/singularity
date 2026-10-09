#!/usr/bin/env node
/**
 * Runtime wiring for a standalone (non-DSH-host) process that loads our control store.
 *
 * The DSH packages are peer dependencies and are never installed: the host DSH profile provides
 * them at runtime, and `tsconfig.json` resolves them for the type checker. A probe started by
 * `node` has no such profile, so this module supplies the same resolution by hand — pointed at the
 * installed 0.2.0-rc.2 build that `docs/context.md` §1 records, never at a registry.
 *
 * The hook resolves through each package's own `exports` map, so it never guesses a layout, and it
 * is limited to `@deepseek-ai/*`. The transitive imports inside the installed tree resolve
 * normally, because the installed tree is a real `node_modules` directory.
 *
 * Import this module **before** importing anything that imports a DSH package; the hook only
 * applies to modules resolved after `register` runs, so keep those imports dynamic.
 *
 * @module singularity-core/scripts/dsh-control-runtime
 */

import { register } from 'node:module'
import { join } from 'node:path'

/** The installed build. Overridable so a different host profile can point the probe somewhere else. */
export const DSH_INSTALLED =
  process.env['DSH_CONTROL_INSTALLED'] ?? '/home/ROXY/.local/node-v22.23.3-linux-x64/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'

const HOOK = `
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const require = createRequire(${JSON.stringify(`${join(DSH_INSTALLED, 'resolve-from-here.cjs')}`)})

export async function resolve(specifier, context, next) {
  if (specifier.startsWith('@deepseek-ai/'))
    return { url: pathToFileURL(require.resolve(specifier)).href, shortCircuit: true }
  return next(specifier, context)
}
`

register(`data:text/javascript,${encodeURIComponent(HOOK)}`)

/** Import one DSH package by name, through the hook above. Call after this module has been evaluated. */
export function dshModule(specifier) {
  return import(specifier)
}

/**
 * One JSONL persistence deployment in this process: the cordis context, the plugin, and the
 * service the control store opens sessions through.
 */
export async function openPersistence(root) {
  const { Context } = await dshModule('@deepseek-ai/cordis')
  const { default: JsonlSessionPersistence } = await dshModule('@deepseek-ai/dsh-session-persistence-jsonl')
  const context = new Context()
  await context.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  return { context, persistence: context.sessionPersistence }
}
