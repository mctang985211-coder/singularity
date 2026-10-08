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

/** The one bubble manifest a round writes and reads back for idempotency. */
interface BubbleManifest {
  readonly graphId: string
  readonly round: number
  /** The committed SHA every component's bubble workspace checked out. */
  readonly components: Readonly<Record<string, string>>
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

/** Copy the graph's production skills and task templates into the bubble's method volume, when the graph has them. */
function copyMethodVolume(dshHome: string, rootSessionId: string, workspace: string): void {
  const library = join(dshHome, 'singularity', 'environments', rootSessionId)
  const skills = join(library, 'skills')
  const templates = join(library, 'task-templates')
  if (!existsSync(skills) && !existsSync(templates)) return
  const volume = join(workspace, '.bubble', 'method-volume')
  mkdirSync(volume, { recursive: true })
  if (existsSync(skills)) cpSync(skills, volume, { recursive: true })
  if (existsSync(templates)) cpSync(templates, join(volume, 'task-templates'), { recursive: true })
}

/**
 * Materialize one round's bubble workspace: every environment component cloned
 * at `rsi/<graphId>/round-<N-1>` (round 1 folds the environment into `round-0`
 * first), plus the method volume and the round's manifest. Idempotent: a
 * manifest already naming this round returns its workspace untouched.
 */
export async function materializeBubble(
  envPath: string,
  dshHome: string,
  rootSessionId: string,
  graphId: string,
  round: number,
): Promise<string> {
  const dir = bubbleDir(dshHome, rootSessionId, round)
  const workspace = join(dir, 'workspace')
  const manifestPath = join(dir, 'bubble-manifest.json')
  if (readManifest(manifestPath)?.round === round) return workspace
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
  copyMethodVolume(dshHome, rootSessionId, workspace)
  const manifest: BubbleManifest = { graphId, round, components, createdAt: new Date().toISOString() }
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
