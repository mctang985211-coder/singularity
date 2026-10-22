#!/usr/bin/env node
/** Execute only an explicitly selected environment's own verification entry. */
import { spawnSync } from 'node:child_process'
import { access, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const args = process.argv.slice(2).filter(arg => arg !== '--')
if (args.length !== 1) throw new Error('Usage: pnpm verify:domain -- <environment-directory>')
const root = await realpath(resolve(args[0]))
const entry = join(root, 'verify.mjs')
try { await access(entry) }
catch (error) {
  if (error.code !== 'ENOENT') throw error
  console.log(`SKIP domain verification: ${entry} is not provided`)
  process.exit(0)
}
const result = spawnSync(process.execPath, [entry], { cwd: root, stdio: 'inherit' })
if (result.error) throw result.error
process.exitCode = result.status ?? 1
