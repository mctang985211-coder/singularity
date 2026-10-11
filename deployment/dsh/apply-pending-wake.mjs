#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const installed = resolve(process.argv[2] ?? '/home/ROXY/singularity-next/dsh/node_modules')
for (const name of ['dsh-agent', 'dsh-agent-loop']) {
  const manifest = JSON.parse(await readFile(join(installed, '@deepseek-ai', name, 'package.json'), 'utf8'))
  if (manifest.version !== '0.2.0-rc.2') throw new Error(`${name}: pending-wake patch requires 0.2.0-rc.2`)
}
const files = JSON.parse(await readFile(join(here, 'pending-wake-files.json'), 'utf8'))
const digest = async path => createHash('sha256').update(await readFile(join(installed, path))).digest('hex')
const current = await Promise.all(files.map(file => digest(file.path)))
if (files.every((file, index) => current[index] === file.after)) {
  process.stdout.write('pending-wake: installed\n')
} else {
  for (const [index, file] of files.entries())
    if (current[index] !== file.before) throw new Error(`${file.path}: installed bytes differ from the patch baseline`)
  const patch = await readFile(join(here, 'pending-wake.patch'))
  for (const flags of [['--dry-run'], []]) {
    const result = spawnSync('patch', ['--batch', '--forward', '-p1', '--directory', installed, ...flags], { input: patch, encoding: 'utf8' })
    if (result.error !== undefined) throw result.error
    if (result.status !== 0) throw new Error(result.stderr || result.stdout || 'patch failed')
  }
  for (const file of files)
    if (await digest(file.path) !== file.after) throw new Error(`${file.path}: patched bytes failed readback`)
  process.stdout.write('pending-wake: applied\n')
}
