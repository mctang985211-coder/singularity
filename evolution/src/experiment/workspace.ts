/** The experiment workspace: the snapshot link policy (escape and loop refusal) and the walk that materializes a frozen input.
 * @module dsh-singularity-evolution/experiment/workspace */

import { lstat, mkdir, readdir, readFile, readlink, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, join, sep } from 'node:path'
import { directoryDigest } from './record.ts'

/** One entry of a snapshot tree: a real directory, or a real file's bytes — never a link of its own. */
type SnapshotInputEntry =
  | { readonly kind: 'directory'; readonly rel: string; readonly mode: number }
  | { readonly kind: 'file'; readonly rel: string; readonly mode: number; readonly bytes: Buffer }

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Is the real path `abs` inside the real path `base` — or `base` itself? */
function inside(base: string, abs: string): boolean {
  return abs === base || abs.startsWith(`${base}${sep}`)
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
): Promise<void> {
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
      let bytes: Buffer
      try {
        bytes = await readFile(real)
      } catch (error) {
        throw new Error(`experiment: the input snapshot file "${lex}" cannot be read: ${message(error)}`)
      }
      await visit({ kind: 'file', rel, mode: stat.mode & 0o7777, bytes })
    }
  }
  await walk(base, '')
}

/** Build one side's workspace from the frozen snapshot, then prove it holds the frozen digest. */
export async function buildWorkspace(sourceDir: string, target: string, snapshotDigest: string): Promise<string> {
  // A key that reaches this point has no run in the store, so nothing in the directory is evidence: rebuild from the frozen snapshot.
  await rm(target, { recursive: true, force: true })
  await mkdir(target, { recursive: true })
  await walkSnapshotInput(sourceDir, async entry => {
    const at = join(target, entry.rel)
    if (entry.kind === 'directory') {
      await mkdir(at, { recursive: true, mode: entry.mode })
      return
    }
    await mkdir(dirname(at), { recursive: true })
    await writeFile(at, entry.bytes, { mode: entry.mode })
  })
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
