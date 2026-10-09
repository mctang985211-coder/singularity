/**
 * Bubble materialization and settlement: one RSI round's isolated workspace.
 *
 * A bubble is a fresh clone of every environment component at one round's
 * branch, plus the round's method volume. It hides the environment checkout and
 * `$DSH_HOME` from the round's agents: what a bubble was materialized with is
 * all a round can see, so a round cannot read the mother port's dirty tree or a
 * previous round's state.
 *
 * @module @dangosys/dsh-singularity-task-runtime/bubble
 */

import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { hasLegacyLayout, libraryRoots, readPointer, readRevision, verifyRevisionDirectory } from '../environment/index.ts'
import type { LibraryRoots } from '../environment/index.ts'

/** The one bubble manifest a round writes and reads back for idempotency. */
interface BubbleManifest {
  readonly graphId: string
  readonly round: number
  /** The committed SHA every component's bubble workspace checked out. */
  readonly components: Readonly<Record<string, string>>
  /** The environment revision the method volume was copied from; absent on a legacy-layout bubble. */
  readonly methodRevisionId?: string
  /** The content digest of that revision's manifest, as copied. */
  readonly methodDigest?: string
  readonly createdAt: string
}

const BUBBLE_GIT = ['-c', 'user.name=bubble', '-c', 'user.email=bubble@local']

function runGit(args: readonly string[], cwd?: string): string {
  const result = spawnSync('git', [...(cwd === undefined ? [] : ['-C', cwd]), ...args], { encoding: 'utf8' })
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || result.error?.message || 'unknown git failure').trim()
    throw new Error(`bubble: git ${args.join(' ')}${cwd === undefined ? '' : ` in ${cwd}`} failed: ${detail}`)
  }
  return result.stdout.trim()
}

/** One environment's component repos: the owner/repo directories that carry a `.git`, never the nested repos inside them. */
function componentRepos(root: string): string[] {
  const found: string[] = []
  for (const entry of directoryEntries(root)) {
    if (existsSync(join(root, entry, '.git'))) {
      found.push(entry)
      continue
    }
    for (const child of directoryEntries(join(root, entry))) {
      if (existsSync(join(root, entry, child, '.git'))) found.push(`${entry}/${child}`)
    }
  }
  return found.sort()
}

function directoryEntries(dir: string): string[] {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const names: string[] = []
  for (const entry of entries) {
    if (entry.name === '.git' || entry.name.startsWith('.')) continue
    // A component is often a symlink to the mother port's checkout; stat follows it and a broken link is simply not a component.
    let isDirectory = false
    try {
      isDirectory = statSync(join(dir, entry.name)).isDirectory()
    } catch {
      isDirectory = false
    }
    if (isDirectory) names.push(entry.name)
  }
  return names
}

function hasCommit(repo: string): boolean {
  return spawnSync('git', ['-C', repo, 'rev-parse', '--verify', 'HEAD'], { encoding: 'utf8' }).status === 0
}

/** The directory holding one round's bubble manifest and workspace. */
function bubbleDir(dshHome: string, rootSessionId: string, round: number): string {
  return join(dshHome, 'singularity', 'environments', rootSessionId, 'bubbles', `round-${round}`)
}

/** The absolute path of one round's bubble workspace, whether or not it has been materialized. */
export function bubbleWorkspacePath(dshHome: string, rootSessionId: string, round: number): string {
  return join(bubbleDir(dshHome, rootSessionId, round), 'workspace')
}

/**
 * The workspace of the graph's latest materialized round, or `undefined` when
 * this graph has no bubble at all. A restarted deployment re-pins an adopted
 * root here: the round's bubble is where its Runs work, and without the mapping
 * the runtime falls back to the environment checkout the bubble was cloned from.
 */
export function latestBubbleWorkspacePath(dshHome: string, rootSessionId: string): string | undefined {
  const bubbles = join(dshHome, 'singularity', 'environments', rootSessionId, 'bubbles')
  let latest: number | undefined
  for (const entry of directoryEntries(bubbles)) {
    const round = /^round-(\d+)$/.exec(entry)
    if (round === null) continue
    if (latest === undefined || Number(round[1]) > latest) latest = Number(round[1])
  }
  return latest === undefined ? undefined : bubbleWorkspacePath(dshHome, rootSessionId, latest)
}

function readManifest(path: string): BubbleManifest | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as BubbleManifest
  } catch {
    return undefined
  }
}

/** Fold each env component's current (dirty) tree into a fresh `rsi/<graphId>/round-0` branch, on the mother port's own repo. */
function genesisRound(envPath: string, graphId: string): void {
  const branch = `rsi/${graphId}/round-0`
  for (const rel of componentRepos(envPath)) {
    const repo = join(envPath, rel)
    if (!hasCommit(repo)) continue
    runGit(['checkout', '-B', branch], repo)
    runGit(['add', '-A'], repo)
    if (runGit(['status', '--porcelain'], repo).length > 0) {
      runGit([...BUBBLE_GIT, 'commit', '-m', 'round-0'], repo)
    }
  }
}

/** Copy the graph's legacy flat skills and task templates into the bubble's method volume, when the old-protocol library has them. */
function copyLegacyMethodVolume(dshHome: string, rootSessionId: string, workspace: string): void {
  const library = join(dshHome, 'singularity', 'environments', rootSessionId)
  const skills = join(library, 'skills')
  const templates = join(library, 'task-templates')
  if (!existsSync(skills) && !existsSync(templates)) return
  const volume = join(workspace, '.bubble', 'method-volume')
  mkdirSync(volume, { recursive: true })
  if (existsSync(skills)) cpSync(skills, volume, { recursive: true })
  if (existsSync(templates)) cpSync(templates, join(volume, 'task-templates'), { recursive: true })
}

/** What one bubble's method volume binds: a frozen revision of the new protocol, or the legacy flat layout an old-protocol graph keeps. */
type MethodVolumeSource = { readonly kind: 'legacy' } | { readonly kind: 'revision'; readonly revisionId: string }

/**
 * Resolve the method volume source of one round's bubble. A legacy library
 * (flat `skills/` without the protocol marker) keeps its old read-only shape
 * and never enters the revision logic; a new-protocol library binds the named
 * revision, or the active pointer's when the round names none. A new-protocol
 * library with no revision to bind is refused by name — never a silent empty
 * volume, never a fallback to the flat path.
 */
async function methodVolumeSource(library: LibraryRoots, methodRevisionId: string | undefined): Promise<MethodVolumeSource> {
  if (await hasLegacyLayout(library)) {
    if (methodRevisionId !== undefined) {
      throw new Error(
        `bubble: library "${library.id}" has the legacy flat layout and holds no revision "${methodRevisionId}"; ` +
          'a legacy graph\'s bubble carries the flat library as-is',
      )
    }
    return { kind: 'legacy' }
  }
  const revisionId = methodRevisionId ?? (await readPointer(library))?.revisionId
  if (revisionId === undefined) {
    throw new Error(
      `bubble: library "${library.id}" has no active environment revision and the round named none; ` +
        'a new-protocol bubble\'s method volume is one frozen revision\'s bytes',
    )
  }
  return { kind: 'revision', revisionId }
}

/** Copy one revision's skills and task templates into the bubble's method volume; a directory missing or failing verification is refused by name. */
async function copyRevisionVolume(
  library: LibraryRoots,
  revisionId: string,
  workspace: string,
): Promise<{ readonly revisionId: string; readonly digest: string }> {
  const revision = await readRevision(library, revisionId)
  if (revision === undefined) {
    throw new Error(
      `bubble: library "${library.id}" holds no revision "${revisionId}"; a bubble's method volume is a frozen revision's bytes, never the flat library's`,
    )
  }
  const { defects } = await verifyRevisionDirectory(revision.root, revision.manifest)
  if (defects.length > 0) {
    throw new Error(`bubble: revision "${revisionId}" of library "${library.id}" does not verify against its manifest:\n- ${defects.join('\n- ')}`)
  }
  const volume = join(workspace, '.bubble', 'method-volume')
  rmSync(volume, { recursive: true, force: true })
  mkdirSync(volume, { recursive: true })
  if (existsSync(revision.skillRoot)) cpSync(revision.skillRoot, volume, { recursive: true })
  if (existsSync(revision.taskTemplatesRoot)) cpSync(revision.taskTemplatesRoot, join(volume, 'task-templates'), { recursive: true })
  return { revisionId, digest: revision.manifest.contentDigest }
}

/**
 * The method revision one materialized bubble's volume carries, read from its
 * manifest — `undefined` for a legacy bubble and for a path that is no bubble
 * workspace. A Run admitted into a bubble binds exactly this revision.
 */
export function bubbleMethodRevisionOf(workspacePath: string): { readonly revisionId: string; readonly digest?: string } | undefined {
  const manifest = readManifest(join(dirname(workspacePath), 'bubble-manifest.json'))
  if (manifest?.methodRevisionId === undefined) return undefined
  return { revisionId: manifest.methodRevisionId, ...(manifest.methodDigest === undefined ? {} : { digest: manifest.methodDigest }) }
}

/**
 * Materialize one round's bubble workspace: every environment component cloned
 * at `rsi/<graphId>/round-<N-1>` (round 1 folds the environment into `round-0`
 * first), plus the method volume and the round's manifest. The method volume is
 * one environment revision's bytes: `options.methodRevisionId` names it (a
 * trial round names its candidate, a graph's first round names the initial
 * revision), and the active pointer answers when the round names none.
 * Idempotent on the pair (round, methodRevisionId): a manifest already naming
 * both returns its workspace untouched, and the same round under another
 * revision is materialized again.
 */
export async function materializeBubble(
  envPath: string,
  dshHome: string,
  rootSessionId: string,
  graphId: string,
  round: number,
  options: { readonly methodRevisionId?: string } = {},
): Promise<string> {
  const dir = bubbleDir(dshHome, rootSessionId, round)
  const workspace = join(dir, 'workspace')
  const manifestPath = join(dir, 'bubble-manifest.json')
  const library = libraryRoots(rootSessionId, dshHome)
  const source = await methodVolumeSource(library, options.methodRevisionId)
  const wantedRevision = source.kind === 'revision' ? source.revisionId : undefined
  const existing = readManifest(manifestPath)
  if (existing?.round === round && existing.methodRevisionId === wantedRevision) return workspace
  mkdirSync(workspace, { recursive: true })
  if (round === 1) genesisRound(envPath, graphId)
  const branch = `rsi/${graphId}/round-${round - 1}`
  const components: Record<string, string> = {}
  for (const rel of componentRepos(envPath)) {
    const target = join(workspace, rel)
    mkdirSync(dirname(target), { recursive: true })
    rmSync(target, { recursive: true, force: true })
    // A local clone hard-links objects and stays self-contained: --shared
    // would leave .git/objects/info/alternates pointing at the mother port,
    // which the bubble's sandbox masks, breaking every git command inside.
    runGit(['clone', join(envPath, rel), target])
    const checkout = spawnSync('git', ['-C', target, 'checkout', branch], { encoding: 'utf8' })
    if (checkout.status !== 0) {
      const detail = (checkout.stderr || checkout.stdout || '').trim()
      throw new Error(`bubble: branch "${branch}" is not in ${join(envPath, rel)}: ${detail}`)
    }
    components[rel] = runGit(['rev-parse', 'HEAD'], target)
  }
  const method =
    source.kind === 'legacy'
      ? (copyLegacyMethodVolume(dshHome, rootSessionId, workspace), undefined)
      : await copyRevisionVolume(library, source.revisionId, workspace)
  const manifest: BubbleManifest = {
    graphId,
    round,
    components,
    ...(method === undefined ? {} : { methodRevisionId: method.revisionId, methodDigest: method.digest }),
    createdAt: new Date().toISOString(),
  }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  return workspace
}

/**
 * Settle one round's bubble: commit each component's work on the bubble and
 * push it to `rsi/<graphId>/round-<N>` on the environment's own repo, so the
 * next round's materialization can read it. A component with nothing to commit
 * still has its branch published. Returns each component's new SHA.
 */
export async function settleBubble(
  envPath: string,
  workspacePath: string,
  graphId: string,
  round: number,
): Promise<Record<string, string>> {
  const shas: Record<string, string> = {}
  if (!existsSync(workspacePath)) return shas
  const branch = `rsi/${graphId}/round-${round}`
  for (const rel of componentRepos(workspacePath)) {
    const repo = join(workspacePath, rel)
    runGit(['add', '-A'], repo)
    if (runGit(['status', '--porcelain'], repo).length > 0) {
      runGit([...BUBBLE_GIT, 'commit', '-m', `round-${round}`], repo)
    }
    runGit(['push', 'origin', `HEAD:refs/heads/${branch}`], repo)
    shas[rel] = runGit(['rev-parse', 'HEAD'], repo)
  }
  return shas
}
