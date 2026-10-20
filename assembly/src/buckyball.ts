import { execFile as execFileCallback } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, posix, resolve, sep } from 'node:path'
import { promisify, TextDecoder } from 'node:util'
import { fileURLToPath } from 'node:url'
import type { VerifierInvocation } from '../../src/verifier/command.ts'
import { sha256 } from './ids.ts'
import type { BubbleWorld } from './bubble.ts'
import type { spawnProcess } from './process.ts'

const execFile = promisify(execFileCallback)
const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0' }
const git = async (repository: string, args: readonly string[], extraEnv: NodeJS.ProcessEnv = {}) => (await execFile('git', ['--no-replace-objects', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', repository, ...args],
  { env: { ...gitEnv, ...extraEnv }, encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 })).stdout
const utf8 = (bytes: Uint8Array): string => new TextDecoder('utf-8', { fatal: true }).decode(bytes)
const portablePath = (path: string): boolean => /^[A-Za-z0-9_.\/-]+$/.test(path) && !path.startsWith('/') &&
  path.split('/').every(part => part !== '' && part !== '.' && part !== '..' && part.toLowerCase() !== '.git')
const inside = (root: string, path: string): boolean => path === root || path.startsWith(root + sep)

export interface BuckyballSource {
  readonly baseCommit: string
  readonly inputTreeDigest: string
  readonly repositories: readonly { readonly path: string; readonly commit: string; readonly tree: string }[]
}
export interface BuckyballChangeSet {
  readonly baseCommit: string
  readonly inputTreeDigest: string
  readonly patch: string
}
/** Submission errors are task failures; unavailable frozen inputs/tools are infrastructure failures. */
export class BuckyballChangeError extends Error {}
export interface BuckyballPatchPolicy {
  readonly allowed: readonly string[]
  readonly protected: readonly string[]
}
interface SourceEntry { readonly path: string; readonly mode: string; readonly oid: string; readonly repository: string }

async function sourceEntries(repository: string, revision: string): Promise<{ source: BuckyballSource; entries: SourceEntry[] }> {
  const repositories: BuckyballSource['repositories'][number][] = [], entries: SourceEntry[] = []
  const visit = async (directory: string, revision: string, prefix: string): Promise<void> => {
    if (repositories.length >= 256) throw new Error('Buckyball source has too many nested repositories')
    const commit = utf8(await git(directory, ['rev-parse', '--verify', `${revision}^{commit}`])).trim()
    const tree = utf8(await git(directory, ['rev-parse', `${commit}^{tree}`])).trim()
    repositories.push({ path: prefix, commit, tree })
    for (const entry of utf8(await git(directory, ['ls-tree', '-rz', '--full-tree', commit])).split('\0').filter(Boolean)) {
      const match = /^(\d+) (blob|commit) ([0-9a-f]+)\t([\s\S]+)$/.exec(entry)
      if (match === null) throw new Error('Unsupported Buckyball Git tree entry')
      const mode = match[1]!, oid = match[3]!, relative = match[4]!
      const path = prefix === '' ? relative : `${prefix}/${relative}`
      if (!portablePath(path)) throw new Error(`Unsupported source path: ${path}`)
      if (mode === '160000') {
        // git -C must never fall through an uninitialized directory to its parent's repository.
        const submodule = join(directory, relative)
        const top = utf8(await git(submodule, ['rev-parse', '--show-toplevel'])).trim()
        if (resolve(top) !== resolve(submodule)) throw new Error(`Missing pinned submodule: ${path}`)
        await visit(submodule, oid, path)
      } else {
        if (!['100644', '100755', '120000'].includes(mode)) throw new Error(`Unsupported source mode: ${mode}`)
        entries.push({ path, mode, oid, repository: directory })
      }
    }
  }
  await visit(repository, revision, '')
  const manifest = repositories.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  const source = { baseCommit: manifest.find(entry => entry.path === '')!.commit, inputTreeDigest: sha256(JSON.stringify(manifest)), repositories: manifest }
  return { source, entries }
}

/** Freeze committed objects, including every pinned submodule; never snapshot an author's dirty tree. */
export async function freezeBuckyballSource(repository: string, revision: string): Promise<BuckyballSource> {
  return (await sourceEntries(repository, revision)).source
}

export function parseBuckyballChangeSet(raw: string): BuckyballChangeSet {
  if (Buffer.byteLength(raw) > 2 * 1024 * 1024) throw new BuckyballChangeError('change-set.json exceeds 2MiB')
  let value: unknown
  try { value = JSON.parse(raw) } catch { throw new BuckyballChangeError('change-set.json is not JSON') }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new BuckyballChangeError('Expected change-set object')
  const object = value as Record<string, unknown>
  if (Object.keys(object).sort().join(',') !== 'baseCommit,inputTreeDigest,patch' || typeof object['baseCommit'] !== 'string' ||
      !/^[0-9a-f]{40}$/.test(object['baseCommit']) || typeof object['inputTreeDigest'] !== 'string' ||
      !/^[0-9a-f]{64}$/.test(object['inputTreeDigest']) || typeof object['patch'] !== 'string') throw new BuckyballChangeError('Invalid change-set fields')
  return object as unknown as BuckyballChangeSet
}

function patchPaths(patch: string, policy: BuckyballPatchPolicy): string[] {
  if (Buffer.byteLength(patch) > 1024 * 1024 || patch.includes('\0') || patch.includes('\r')) throw new BuckyballChangeError('Patch must be LF text of at most 1MiB')
  if (!policy.allowed.length || [...policy.allowed, ...policy.protected].some(path => !portablePath(path))) throw new Error('Invalid patch scope')
  const paths: string[] = []
  for (const line of patch.split('\n')) {
    if (/^(?:GIT binary patch|Binary files |old mode |new mode |rename |copy |similarity index |dissimilarity index )/.test(line) ||
        /^(?:new file mode|deleted file mode) (?!100644$)/.test(line)) throw new BuckyballChangeError('Only ordinary text edits, additions and deletions are supported')
    if (!line.startsWith('diff --git ')) continue
    const match = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line), path = match?.[1]
    if (path === undefined || path !== match?.[2] || !portablePath(path)) throw new BuckyballChangeError('Unsupported patch path or rename')
    const covers = (scope: string) => path === scope || path.startsWith(scope + '/')
    if (!policy.allowed.some(covers) || policy.protected.some(covers)) throw new BuckyballChangeError(`Patch is outside allowed scope: ${path}`)
    if (paths.includes(path)) throw new BuckyballChangeError(`Repeated patch path: ${path}`)
    paths.push(path)
  }
  if (!paths.length || paths.length > 32 || !patch.startsWith('diff --git ')) throw new BuckyballChangeError('Patch must edit between 1 and 32 files')
  // git accepts traditional headers independently of diff --git; require one matching pair per section.
  for (const section of patch.split(/^diff --git /m).slice(1)) {
    const path = /^a\/(\S+) b\//.exec(section)![1]!
    const old = section.match(/^--- (.+)$/gm), next = section.match(/^\+\+\+ (.+)$/gm)
    if (old?.length !== 1 || next?.length !== 1 || ![`--- a/${path}`, '--- /dev/null'].includes(old[0]!) ||
        ![`+++ b/${path}`, '+++ /dev/null'].includes(next[0]!)) throw new BuckyballChangeError('Patch headers do not match declared paths')
  }
  return paths
}

async function assertSymlinks(entries: readonly SourceEntry[]): Promise<void> {
  const links = new Map<string, string>()
  for (const entry of entries) if (entry.mode === '120000') links.set(entry.path, utf8(await git(entry.repository, ['cat-file', 'blob', entry.oid])))
  for (const [path, target] of links) {
    if (posix.isAbsolute(target) || target.includes('\\') || target.includes('\0')) throw new Error(`Unsafe source symlink: ${path}`)
    let current = posix.normalize(posix.join(posix.dirname(path), target))
    const seen = new Set<string>()
    for (;;) {
      if (current === '..' || current.startsWith('../')) throw new Error(`Escaping source symlink: ${path}`)
      const components = current.split('/'), index = components.findIndex((_, index) => links.has(components.slice(0, index + 1).join('/')))
      if (index < 0) break
      if (seen.has(current) || seen.size >= 40) throw new Error(`Cyclic source symlink: ${path}`)
      seen.add(current)
      const prefix = components.slice(0, index + 1).join('/'), linked = links.get(prefix)!
      if (posix.isAbsolute(linked)) throw new Error(`Unsafe source symlink: ${path}`)
      current = posix.normalize(posix.join(posix.dirname(prefix), linked, ...components.slice(index + 1)))
    }
  }
}

/** Called by a host verifier with a fresh Run-owned directory, never by an agent tool. */
export async function prepareBuckyballTrial(repository: string, frozen: BuckyballSource, change: BuckyballChangeSet,
  policy: BuckyballPatchPolicy, trial: string): Promise<readonly string[]> {
  if (inside(resolve(repository), resolve(trial)) || inside(resolve(trial), resolve(repository))) throw new Error('Trial must be separate from the author repository')
  if (change.baseCommit !== frozen.baseCommit || change.inputTreeDigest !== frozen.inputTreeDigest) throw new BuckyballChangeError('Change-set does not match frozen source')
  const paths = patchPaths(change.patch, policy)
  const actual = await sourceEntries(repository, frozen.baseCommit)
  if (actual.source.inputTreeDigest !== frozen.inputTreeDigest) throw new Error('Frozen source manifest does not match available Git objects')
  await assertSymlinks(actual.entries)
  for (const entry of actual.entries) if (posix.basename(entry.path) === '.gitattributes' &&
      /\bexport-(ignore|subst)\b/.test(utf8(await git(entry.repository, ['cat-file', 'blob', entry.oid])))) throw new Error('Archive-transforming attributes are not supported')
  for (const path of paths) if (actual.entries.some(entry => entry.mode === '120000' && (path === entry.path || path.startsWith(entry.path + '/')))) throw new BuckyballChangeError(`Patch traverses source symlink: ${path}`)
  await mkdir(trial)
  const temporary = await mkdtemp(join(tmpdir(), 'buckyball-export-'))
  try {
    // A private archive repository avoids mutable source .git/info/attributes and local config.
    await git(temporary, ['init', '--bare', '--quiet'])
    for (const entry of frozen.repositories) {
      const archive = join(temporary, 'source.tar'), destination = join(trial, entry.path)
      await mkdir(destination, { recursive: true })
      const module = join(repository, entry.path)
      const objects = resolve(module, utf8(await git(module, ['rev-parse', '--git-path', 'objects'])).trim())
      await writeFile(archive, await git(temporary, ['archive', '--format=tar', entry.commit], { GIT_ALTERNATE_OBJECT_DIRECTORIES: objects }))
      await execFile('tar', ['--extract', '--file', archive, '--directory', destination, '--no-same-owner', '--no-same-permissions'])
    }
    for (const path of paths) {
      const entry = actual.entries.find(entry => entry.path === path)
      if (entry !== undefined) {
        const before = await readFile(join(trial, path))
        if (before.includes(0) || before.length > 1024 * 1024) throw new Error(`Patch target is not supported text: ${path}`)
        utf8(before)
      }
    }
    const patch = join(temporary, 'change.patch')
    await writeFile(patch, change.patch)
    await git(trial, ['init', '--quiet'])
    try {
      await git(trial, ['apply', '--check', '--whitespace=error-all', patch])
      await git(trial, ['apply', '--whitespace=error-all', patch])
    } catch (error) {
      if (typeof (error as { code?: unknown }).code !== 'number') throw error
      throw new BuckyballChangeError(`Patch does not apply: ${String(error)}`)
    }
    for (const path of paths) {
      const stat = await lstat(join(trial, path)).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return undefined })
      if (stat === undefined) continue
      if (!stat.isFile() || stat.size > 1024 * 1024) throw new BuckyballChangeError(`Patched target is not supported text: ${path}`)
      const after = await readFile(join(trial, path))
      if (after.includes(0)) throw new BuckyballChangeError(`Patched target contains binary data: ${path}`)
      try { utf8(after) } catch { throw new BuckyballChangeError(`Patched target is not UTF-8: ${path}`) }
    }
    // Candidate/build tools need no Git metadata and must not discover the author's repository.
    await rm(join(trial, '.git'), { recursive: true })
    return paths
  } catch (error) {
    await rm(trial, { recursive: true, force: true })
    throw error
  } finally { await rm(temporary, { recursive: true, force: true }) }
}

export interface BuckyballCheck { readonly id: string; readonly argv: readonly [string, ...string[]] }
export interface BuckyballVerificationInput {
  readonly version: 1
  readonly repository: string
  readonly source: BuckyballSource
  readonly policy: BuckyballPatchPolicy
  readonly checks: readonly BuckyballCheck[]
  readonly immutableFiles: readonly { readonly path: string; readonly digest: string }[]
}

/** Public work specification. The opaque digest binds the host-only verification manifest. */
export function buckyballTaskInput(input: BuckyballVerificationInput) {
  return { version: 1 as const, repository: input.repository, source: input.source, policy: input.policy,
    verificationDigest: sha256(JSON.stringify(input)) }
}

/** Host-only manifest freezes oracle/tool bytes as well as command lines and source. */
export async function verifyBuckyballChangeSet(raw: string, input: BuckyballVerificationInput, trial: string,
  runProcess: (invocation: VerifierInvocation, signal?: AbortSignal, cwd?: string, world?: BubbleWorld) => ReturnType<typeof spawnProcess>, signal?: AbortSignal) {
  if (input.version !== 1 || !input.repository.startsWith('/') || !input.immutableFiles.length || !input.checks.length) throw new Error('Incomplete frozen Buckyball verification input')
  for (const implementation of [fileURLToPath(import.meta.url), fileURLToPath(new URL('./ids.ts', import.meta.url))])
    if (!input.immutableFiles.some(file => file.path === implementation)) throw new Error(`Unpinned verifier implementation: ${implementation}`)
  for (const file of input.immutableFiles) if (!file.path.startsWith('/') || !/^[0-9a-f]{64}$/.test(file.digest) || sha256(await readFile(file.path)) !== file.digest)
    throw new Error(`Frozen oracle/tool content differs: ${file.path}`)
  for (const check of input.checks) for (const argument of check.argv) if (argument.startsWith('/') && !input.immutableFiles.some(file => file.path === argument))
    throw new Error(`Unpinned oracle/tool path: ${check.id}: ${argument}`)
  const change = parseBuckyballChangeSet(raw)
  const paths = await prepareBuckyballTrial(input.repository, input.source, change, input.policy, trial)
  const checks = await checkBuckyballTrial(trial, input.checks, input.immutableFiles.map(file => file.path), runProcess, signal)
  return { version: 1 as const, baseCommit: change.baseCommit, inputTreeDigest: change.inputTreeDigest, artifactDigest: sha256(raw), paths, checks,
    verdict: checks.some(check => check.status === 'invalid') ? 'unknown' as const : checks.every(check => check.status === 'pass') ? 'pass' as const : 'fail' as const }
}

export async function checkBuckyballTrial(trial: string, checks: readonly BuckyballCheck[], references: readonly string[],
  runProcess: (invocation: VerifierInvocation, signal?: AbortSignal, cwd?: string, world?: BubbleWorld) => ReturnType<typeof spawnProcess>, signal?: AbortSignal) {
  if (!checks.length || new Set(checks.map(check => check.id)).size !== checks.length) throw new Error('Distinct frozen external checks are required')
  const results = []
  for (const check of checks) {
    signal?.throwIfAborted()
    if (!check.argv[0].startsWith('/')) throw new Error('Oracle executable must be an absolute frozen path')
    const result = await runProcess({ shell: false, argv: check.argv }, signal, trial, { root: trial, writable: true, protected: [], references })
    results.push({ id: check.id, argv: check.argv, ...result,
      status: result.failure !== undefined || result.exitCode === null || result.exitCode === 4 ? 'invalid' as const : result.exitCode === 0 ? 'pass' as const : 'fail' as const })
  }
  return results
}
