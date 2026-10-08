/** The experiment workspace: the snapshot link policy (escape and loop refusal) and the walk that materializes a frozen input.
 * @module dsh-singularity-evolution/experiment/workspace */

import { chmod, copyFile, lstat, mkdir, readdir, readlink, realpath, rm } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { directoryDigest } from './record.ts'
import { normalizeSnapshotPaths } from '../replay/snapshot.ts'

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
