import { execFile as execFileCallback } from 'node:child_process'
import { access, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { constants } from 'node:fs'
import { delimiter, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { freezeBuckyballSource } from '../../assembly/src/buckyball.ts'
import { sha256 } from '../../assembly/src/ids.ts'

const execFile = promisify(execFileCallback)
const repository = process.argv[2]
if (repository === undefined) throw new Error('Usage: node domains/buckyball/inspect.mjs /path/to/buckyball')
const directory = resolve(repository)
const git = async (...args) => (await execFile('git', ['--no-replace-objects', '-c', 'core.fsmonitor=false', '-C', directory, ...args],
  { timeout: 30_000, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } })).stdout.trim()
const head = await git('rev-parse', 'HEAD'), status = await git('status', '--porcelain=v1')
const tools = []
const scratch = await mkdtemp(join(tmpdir(), 'buckyball-inspect-'))
try {
for (const [name, flag] of [['node', '--version'], ['nix', '--version'], ['bwrap', '--version'], ['rustc', '--version'], ['cargo', '--version'],
  ['verilator', '--version'], ['mill', '--version'], ['riscv64-unknown-elf-gcc', '--version'], ['buddy-opt', '--version']]) {
  let path
  for (const prefix of (process.env.PATH ?? '').split(delimiter)) {
    const candidate = join(prefix, name)
    try { await access(candidate, constants.X_OK); path = await realpath(candidate); break } catch {}
  }
  if (path === undefined) { tools.push({ name, available: false }); continue }
  try {
    const output = await execFile(path, [flag], { cwd: scratch, timeout: 10_000, maxBuffer: 1024 * 1024 })
    tools.push({ name, available: true, path, digest: sha256(await readFile(path)), version: (output.stdout + output.stderr).trim().split('\n')[0] })
  } catch (error) { tools.push({ name, available: false, path, reason: error.message }) }
}
} finally { await rm(scratch, { recursive: true, force: true }) }
let source, sourceError
try { source = await freezeBuckyballSource(directory, head) } catch (error) { sourceError = String(error) }
let environmentStore
try { environmentStore = await realpath(join(directory, 'result')) } catch {}
console.log(JSON.stringify({ version: 1, inspectedAt: new Date().toISOString(), repository: directory, head,
  authorWorktreeStatus: status.split('\n').filter(Boolean), recursiveSubmodules: (await git('submodule', 'status', '--recursive')).split('\n'),
  flakeLockDigest: sha256(await readFile(join(directory, 'flake.lock'))), environmentStore, tools,
  source: source ?? null, ...(sourceError === undefined ? {} : { sourceError }),
  sourceFreezeReady: source !== undefined, readyForTrials: false,
  trialReadinessReason: 'Requires a separately frozen task, independent oracle and resource policy.', domainEffectEvidence: 'not-run',
}, null, 2))
