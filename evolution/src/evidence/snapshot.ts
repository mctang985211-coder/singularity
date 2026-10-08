/**
 * The frozen input both sides are built from: the snapshot walk, the recursive
 * input digest and the workspace builder. This module is the one owner of the
 * snapshot vocabulary — a second walk or a second digest is a regression.
 */

import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { createReadStream } from 'node:fs'
import { chmod, copyFile, lstat, mkdir, readdir, readlink, realpath, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path'
import { sha256Hex } from '@dangosys/dsh-singularity-task'
import type { PlannedInput } from '../types.ts'

/** The snapshot one evaluation freezes: a directory, optional paths and the digest every side is checked against. */
export interface InputSnapshot {
  readonly sourceDir: string
  readonly paths?: readonly string[]
  readonly rebaseFrom?: string
}

/** One entry of a snapshot tree: a real directory or file — never a link of its own. */
type SnapshotInputEntry =
  | { readonly kind: 'directory'; readonly rel: string; readonly mode: number }
  | { readonly kind: 'file'; readonly rel: string; readonly mode: number; readonly path: string }

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Is the real path `abs` inside the real path `base` — or `base` itself? */
function inside(base: string, abs: string): boolean {
  return abs === base || abs.startsWith(base.endsWith(sep) ? base : `${base}${sep}`)
}

/** Resolve existing ancestors too, so an alias into the input cannot hide a destructive overlap. */
async function realTarget(path: string): Promise<string> {
  try { return await realpath(path) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const parent = dirname(path)
    if (parent === path) throw error
    return join(await realTarget(parent), path.slice(parent.length))
  }
}

export function normalizeSnapshotPaths(value: unknown): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length === 0 || value.some(path =>
    typeof path !== 'string' || !path || isAbsolute(path) || path.split('/').includes('..') || normalize(path) === '.'))
    throw new Error('experiment: snapshot.paths must name non-empty relative files or directories inside sourceDir')
  const paths = [...new Set((value as string[]).map(path => normalize(path).replace(/\/$/, '')))].sort()
  return paths.filter(path => !paths.some(parent => path !== parent && path.startsWith(`${parent}/`)))
}

export function normalizeSnapshot(snapshot: { sourceDir: string; paths?: string[]; rebaseFrom?: string }): { sourceDir: string; paths?: string[]; rebaseFrom?: string } {
  if (typeof snapshot.sourceDir !== 'string' || !snapshot.sourceDir.trim())
    throw new Error('experiment: snapshot.sourceDir must name an input directory')
  const paths = normalizeSnapshotPaths(snapshot.paths)
  if (snapshot.rebaseFrom !== undefined && (typeof snapshot.rebaseFrom !== 'string' || !isAbsolute(snapshot.rebaseFrom) || resolve(snapshot.rebaseFrom) === '/'))
    throw new Error('experiment: snapshot.rebaseFrom must name the original absolute workspace directory')
  return {
    sourceDir: resolve(snapshot.sourceDir),
    ...(paths === undefined ? {} : { paths }),
    ...(snapshot.rebaseFrom === undefined ? {} : { rebaseFrom: resolve(snapshot.rebaseFrom) }),
  }
}

/** Resolve one symbolic link to the real path it names. A chain that loops or escapes is refused. */
export async function resolveLink(lex: string, base: string): Promise<string> {
  const text = await readlink(lex).catch(() => '?')
  let target: string
  try {
    target = await realpath(lex)
  } catch (error) {
    const reason = (error as NodeJS.ErrnoException).code === 'ELOOP' ? 'its target chain loops' : message(error)
    throw new Error(`experiment: the input snapshot link "${lex}" -> "${text}" cannot be resolved: ${reason}`)
  }
  if (!inside(base, target)) {
    throw new Error(
      `experiment: the input snapshot link "${lex}" -> "${text}" resolves to "${target}", outside the snapshot root ` +
        `"${base}" — a frozen input may hold only files and links that resolve inside it`,
    )
  }
  return target
}

/** Walk the snapshot at `root` in sorted relative-path order, awaiting `visit` */
export async function walkSnapshotInput(
  root: string,
  visit: (entry: SnapshotInputEntry) => Promise<void>,
  selectedPaths?: readonly string[],
): Promise<void> {
  const paths = normalizeSnapshotPaths(selectedPaths)
  const found = new Set<string>()
  let base: string
  try {
    base = await realpath(root)
  } catch (error) {
    throw new Error(`experiment: the input snapshot "${root}" cannot be resolved: ${message(error)}`)
  }
  // The real directories on the way here: a link may name one of them, which is
  // a tree with no end — the refusal a loop gets, named for the path that made it.
  const open = new Set<string>([base])
  const walk = async (current: string, prefix: string): Promise<void> => {
    let names: string[]
    try {
      names = [...(await readdir(current))].sort()
    } catch (error) {
      throw new Error(`experiment: the input snapshot directory "${current}" cannot be read: ${message(error)}`)
    }
    for (const name of names) {
      const rel = prefix === '' ? name : `${prefix}/${name}`
      if (paths !== undefined && !paths.some(path => path === rel || rel.startsWith(`${path}/`) || path.startsWith(`${rel}/`))) continue
      if (paths?.includes(rel)) found.add(rel)
      const lex = join(current, name)
      let entry
      try {
        entry = await lstat(lex)
      } catch (error) {
        throw new Error(`experiment: the input snapshot entry "${lex}" cannot be read: ${message(error)}`)
      }
      const real = entry.isSymbolicLink() ? await resolveLink(lex, base) : lex
      let stat = entry
      if (real !== lex) {
        try {
          stat = await lstat(real)
        } catch (error) {
          throw new Error(
            `experiment: the input snapshot entry "${real}", the target of the link "${lex}", cannot be read: ${message(error)}`,
          )
        }
      }
      if (stat.isDirectory()) {
        if (open.has(real)) {
          const named = real === lex ? `directory "${lex}"` : `link "${lex}" -> "${real}"`
          throw new Error(
            `experiment: the input snapshot ${named} is already on the way here — the tree it names has no end, ` +
              'so it cannot be frozen as input',
          )
        }
        open.add(real)
        await visit({ kind: 'directory', rel, mode: stat.mode & 0o7777 })
        await walk(real, rel)
        open.delete(real)
        continue
      }
      if (!stat.isFile()) {
        const through = real === lex ? '' : ` (through the link "${lex}")`
        throw new Error(
          `experiment: the input snapshot holds "${real}"${through}, which is neither a regular file nor a directory — ` +
            'only regular files, directories and links into the snapshot can be frozen as input',
        )
      }
      await visit({ kind: 'file', rel, mode: stat.mode & 0o7777, path: real })
    }
  }
  await walk(base, '')
  for (const path of paths ?? []) if (!found.has(path)) throw new Error(`experiment: selected snapshot path "${path}" does not exist in "${root}"`)
}

/** The recursive content digest of a directory — the input snapshot identity the freeze fixes. */
export async function directoryDigest(directory: string, paths?: readonly string[]): Promise<string> {
  const lines: string[] = []
  await walkSnapshotInput(directory, async entry => {
    if (entry.kind !== 'file') return
    const hash = createHash('sha256')
    try {
      for await (const chunk of createReadStream(entry.path)) hash.update(chunk)
    } catch (error) {
      throw new Error(`experiment: the input snapshot file "${join(directory, entry.rel)}" cannot be read: ${(error as Error).message}`)
    }
    lines.push(`${entry.rel}\0${hash.digest('hex')}`)
  }, paths)
  return sha256Hex(lines.join('\n'))
}

/** Build one side's workspace from the frozen snapshot, then prove it holds the frozen digest. */
export async function buildWorkspace(sourceDir: string, target: string, snapshotDigest: string, paths?: readonly string[]): Promise<string> {
  const source = await realpath(sourceDir)
  const destination = await realTarget(resolve(target))
  if (inside(source, destination) || inside(destination, source))
    throw new Error('experiment: each side workspace must be separate from its frozen input directory')
  // A key that reaches this point has no run in the store, so nothing in the directory is evidence: rebuild from the frozen snapshot.
  await rm(target, { recursive: true, force: true })
  await mkdir(target, { recursive: true })
  const directories: { path: string; mode: number }[] = []
  await walkSnapshotInput(sourceDir, async entry => {
    const at = join(target, entry.rel)
    if (entry.kind === 'directory') {
      await mkdir(at, { recursive: true })
      directories.push({ path: at, mode: entry.mode })
      return
    }
    await mkdir(dirname(at), { recursive: true })
    // Copy-on-write when supported; ordinary copy otherwise. Never hard-link
    // writable sides to each other or to production inputs.
    await copyFile(entry.path, at, constants.COPYFILE_FICLONE)
    await chmod(at, entry.mode)
  }, paths)
  for (const directory of directories.reverse()) await chmod(directory.path, directory.mode)
  const real = await realpath(target)
  const digest = await directoryDigest(real)
  if (digest !== snapshotDigest) {
    throw new Error(
      `the workspace "${real}" was built from the frozen snapshot but hashes to ${digest}, not the frozen ${snapshotDigest}; ` +
        'the build did not reproduce the frozen input, so nothing runs in it',
    )
  }
  return real
}

/** Freeze one input snapshot into a plan's own `PlannedInput`, digesting exactly what the sides will be built from. */
export async function freezeInput(snapshot: InputSnapshot): Promise<PlannedInput> {
  const normalized = normalizeSnapshot({
    sourceDir: snapshot.sourceDir,
    ...(snapshot.paths === undefined ? {} : { paths: [...snapshot.paths] }),
    ...(snapshot.rebaseFrom === undefined ? {} : { rebaseFrom: snapshot.rebaseFrom }),
  })
  const digest = await directoryDigest(normalized.sourceDir, normalized.paths)
  return {
    sourceDir: normalized.sourceDir,
    ...(normalized.paths === undefined ? {} : { paths: normalized.paths }),
    ...(normalized.rebaseFrom === undefined ? {} : { rebaseFrom: normalized.rebaseFrom }),
    digest,
  }
}

/** The workspace one side of one sample runs in, built from the frozen input and checked against its digest. */
export async function materializeSideWorkspace(input: {
  planInput: PlannedInput
  root: string
  sampleTaskId: string
  side: 'baseline' | 'candidate'
}): Promise<{ path: string; digest: string }> {
  const target = resolve(input.root, input.sampleTaskId, input.side)
  const workspace = await buildWorkspace(input.planInput.sourceDir, target, input.planInput.digest, input.planInput.paths)
  const digest = await directoryDigest(input.planInput.sourceDir, input.planInput.paths)
  if (digest !== input.planInput.digest) {
    throw new Error(
      `evolution: the frozen input of "${input.planInput.sourceDir}" reads ${digest}, not the ${input.planInput.digest} the plan froze — a ` +
        'comparison against an input that moved is not the comparison that was frozen',
    )
  }
  return { path: workspace, digest }
}
