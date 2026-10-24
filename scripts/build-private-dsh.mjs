#!/usr/bin/env node
/** Rebuild the pinned host from source without modifying any existing installation. */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { CHECKOUT, hostFindings } from './host-config.mjs'

const [destination, ...extra] = process.argv.slice(2).filter(arg => arg !== '--')
if (!destination || extra.length) throw new Error('Usage: pnpm build-private-dsh -- <empty-directory>')
const root = resolve(destination)
await mkdir(root, { recursive: true })
if ((await readdir(root)).length) throw new Error(`Destination must be empty: ${root}`)
const baseline = JSON.parse(await readFile(join(CHECKOUT, 'dsh-baseline.json'), 'utf8'))
const commands = []
function run(command, args, cwd = root, capture = false) {
  commands.push({ command, args, cwd })
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: capture ? 'pipe' : 'inherit',
    env: { ...process.env, ELECTRON_SKIP_BINARY_DOWNLOAD: '1' },
  })
  if (result.error) throw result.error
  if (result.status !== 0)
    throw new Error(`${command} ${args.join(' ')} failed (${result.status}): ${result.stderr ?? ''}`)
  return result.stdout?.trim()
}
const source = join(root, 'source')
run('git', [
  'clone',
  '--branch',
  baseline.checkout.tag,
  '--single-branch',
  '--',
  process.env['DSH_SOURCE_REPOSITORY'] || baseline.checkout.repository,
  source,
])
if (run('git', ['rev-parse', 'HEAD'], source, true) !== baseline.checkout.commit)
  throw new Error('DSH tag does not resolve to the pinned commit')
for (const patch of baseline.patches) {
  const file = join(CHECKOUT, 'third_party/dsh', patch.name + '.patch')
  if (
    createHash('sha256')
      .update(await readFile(file))
      .digest('hex') !== patch.sha256
  )
    throw new Error(`Source patch digest mismatch: ${patch.name}`)
  run('git', ['apply', '--check', file], source)
  run('git', ['apply', file], source)
}
// pnpm selects the packageManager version declared by the pinned upstream checkout.
run('pnpm', ['install', '--frozen-lockfile'], source)
// Build every production project. The upstream aggregates also include thousands
// of test mocks whose Agent literals predate wake(); those are not host artifacts.
const ts = createRequire(join(source, 'package.json'))('typescript')
run('pnpm', ['run', 'build:native-system'], source)
for (const face of ['host', 'client']) {
  const config = ts.readConfigFile(join(source, `tsconfig.${face}.json`), ts.sys.readFile)
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'))
  const file = `tsconfig.private-${face}.json`
  await writeFile(
    join(source, file),
    JSON.stringify(
      { extends: `./tsconfig.${face}.json`, files: [], include: [], references: config.config.references },
      null,
      2,
    ) + '\n',
  )
  run(process.execPath, ['node_modules/typescript/bin/tsc', '-b', file], source)
  run('pnpm', ['exec', 'tsdown', '--env.DSH_BUILD_FACE', face], source)
  if (face === 'host') run('pnpm', ['--filter', '@deepseek-ai/dsh-desktop', 'run', 'bundle'], source)
}
run('pnpm', ['run', 'build:web'], source)
const packages = JSON.parse(run('pnpm', ['list', '-r', '--depth', '-1', '--json'], source, true))
const installed = join(root, 'installed/node_modules/@deepseek-ai')
await mkdir(installed, { recursive: true })
for (const pkg of packages)
  if (pkg.name?.startsWith('@deepseek-ai/'))
    await symlink(pkg.path, join(installed, pkg.name.slice('@deepseek-ai/'.length)), 'dir')
const bin = join(root, 'installed/node_modules/.bin')
await mkdir(bin)
await chmod(join(source, 'apps/cli/lib/bin.js'), 0o755)
await symlink(join(source, 'apps/cli/lib/bin.js'), join(bin, 'dsh'))
const findings = hostFindings(installed, baseline)
if (findings.length) throw new Error(findings.join('\n'))
await writeFile(
  join(root, 'build-record.json'),
  JSON.stringify(
    {
      commit: baseline.checkout.commit,
      node: process.version,
      packageManager: JSON.parse(await readFile(join(source, 'package.json'), 'utf8')).packageManager,
      patches: baseline.patches,
      artifacts: baseline.artifacts,
      commands,
    },
    null,
    2,
  ) + '\n',
)
console.log(`Private DSH rebuilt and verified. Run pnpm setup:host ${installed}`)
