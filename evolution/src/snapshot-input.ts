/**
 * Walking a frozen input snapshot under the snapshot's link policy: the one
 * traversal the digest that freezes it and the copy that builds each side's
 * workspace share.
 *
 * Why it is a module of its own: the digest and the copy must agree about every
 * entry, or the digest would describe an input the run does not read. A symbolic
 * link is where they could drift — `cp`'s default keeps one — and a kept link is
 * a *shared* target: a run that writes through it writes into the production
 * checkout the snapshot was taken from, the other side reads those rewritten
 * bytes, and both sides' digests still equal the frozen one. The policy here is
 * therefore that every entry is read as the content it really names. A link that
 * resolves inside the snapshot is followed — a link to a file is read as that
 * file, a link to a directory is walked as that directory under the link's own
 * relative path — so the digest hashes the resolved bytes and the copy
 * materializes them into each side's own workspace. A link whose target escapes
 * the snapshot root, whose chain loops, or whose target cannot be resolved is a
 * refusal by name, and it happens wherever the tree is first read: at the
 * freeze, and again at every copy.
 *
 * Only Node standard fs: the rule is about `lstat`/`realpath` semantics, not
 * about any harness service.
 * @module dsh-singularity-evolution/snapshot-input
 */

import { lstat, readdir, readFile, readlink, realpath } from 'node:fs/promises'
import { join, sep } from 'node:path'

/** One entry of a snapshot tree: a real directory, or a real file's bytes — never a link of its own. */
export type SnapshotInputEntry =
  | { readonly kind: 'directory'; readonly rel: string; readonly mode: number }
  | { readonly kind: 'file'; readonly rel: string; readonly mode: number; readonly bytes: Buffer }

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Is the real path `abs` inside the real path `base` — or `base` itself? */
function inside(base: string, abs: string): boolean {
  return abs === base || abs.startsWith(`${base}${sep}`)
}

/**
 * Resolve one symbolic link to the real path it names. A chain that loops
 * (`ELOOP`), a target that is missing or otherwise cannot be resolved, and a
 * target outside the snapshot root are all refusals that name the link, its
 * target text and the reason.
 */
async function resolveLink(lex: string, base: string): Promise<string> {
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

/**
 * Walk the snapshot at `root` in sorted relative-path order, awaiting `visit`
 * for every directory and every regular file of the tree **as the content it
 * really names**: a link is resolved first, so a caller that rebuilds the tree
 * (the copy) writes a parent before its children, and a link position becomes
 * real content rather than a pointer at a shared target. The root itself may be
 * named through a link; the policy measures containment in real paths, so what
 * the snapshot *is* is what is compared.
 */
export async function walkSnapshotInput(root: string, visit: (entry: SnapshotInputEntry) => Promise<void>): Promise<void> {
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
      names = [...await readdir(current)].sort()
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
