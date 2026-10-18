#!/usr/bin/env node
/** Native package resolution for standalone probes; never downloads host dependencies. */
import { homedir } from 'node:os'
import { register } from 'node:module'
import { join, resolve } from 'node:path'
import { CHECKOUT, hostFindings, hostInstall } from './host-config.mjs'

export const DSH_INSTALLED = hostInstall()
const findings = hostFindings(DSH_INSTALLED)
if (findings.length) throw new Error(findings.join('\n'))

/** A checkout-local private home is safe for offline probes; deployments can set DSH_HOME. */
export const DSH_HOME = resolve(process.env['DSH_HOME'] || join(CHECKOUT, '.singularity/home'))
if (DSH_HOME === join(homedir(), '.dsh'))
  throw new Error('DSH_HOME points at the global harness home; use a separate private DSH_HOME')

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
 *
 * `compression` defaults to `none` because every probe that owns a temporary root writes plain JSONL.
 * A probe that opens a root a real host also writes must pass the encoding that host uses — the
 * backend refuses a root holding both, by name, rather than reading a log it cannot parse.
 */
export async function openPersistence(root, compression = 'none') {
  const { Context } = await dshModule('@deepseek-ai/cordis')
  const { default: JsonlSessionPersistence } = await dshModule('@deepseek-ai/dsh-session-persistence-jsonl')
  const context = new Context()
  await context.plugin(JsonlSessionPersistence, { root, compression })
  return { context, persistence: context.sessionPersistence }
}

/** The binary from the same installation whose packages were verified. */
export const DSH_BIN = process.env['DSH_BIN'] ?? join(DSH_INSTALLED, '..', '.bin', 'dsh')
