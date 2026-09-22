/**
 * Reading files without following a link: the one implementation of "a path
 * under a root, walked one component at a time through `lstat`".
 *
 * Why it is a module of its own: both the Evolution ledger (skill candidates in
 * a proposal sandbox, the production skill baseline) and the skill sidecar
 * loader read files whose identity they then vouch for. A read that followed a
 * symbolic link would let the digest describe one file while the path a worker
 * opens is another — so every component from the root to the file must be a
 * real entry, and a link, a directory in a file's place, or a fifo anywhere on
 * the way is a refusal, never a silent follow. The check lives here once, so
 * the two callers cannot drift into two rules.
 *
 * Only Node standard fs: the walk is about `lstat` semantics, not about any
 * harness service.
 * @module @dangosys/dsh-singularity-task-runtime/verified-read
 */

import { lstat, readFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'

/**
 * Where a component walk under a root stopped. The walk is split from the read
 * so a caller that records "absent" can tell it apart from a path that changed
 * type: `missing` is a value, a link or a wrong type is a throw.
 */
export type VerifiedWalk =
  | { missing: false; abs: string }
  | { missing: true; reason: 'no such file or directory' | 'a path component is not a directory' }

/** Resolve `rel` under `base`, refusing anything that would land outside. */
function resolveWithin(base: string, rel: string): string {
  const abs = resolve(base, rel)
  if (abs !== base && !abs.startsWith(`${base}${sep}`)) {
    throw new Error(`verified-read: path ${JSON.stringify(rel)} escapes ${base}`)
  }
  return abs
}

/**
 * Walk `rel` under `root` one component at a time, refusing anything but real
 * entries: a symbolic link anywhere on the path, a non-regular entry where the
 * target should be, or a non-directory where a directory should be all fail
 * loudly, so a read can never land outside the root through a redirected path
 * even though the lexical path stays inside. A component that is simply absent
 * (ENOENT / ENOTDIR anywhere along the walk) is reported as `missing`, never
 * thrown — the caller decides whether absence is an error or an answer.
 */
export async function walkVerified(root: string, rel: string): Promise<VerifiedWalk> {
  const abs = resolveWithin(root, rel)
  const steps = relative(root, abs).split(sep)
  let current = root
  for (const step of steps) {
    current = join(current, step)
    let stat
    try {
      stat = await lstat(current)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        return { missing: true, reason: code === 'ENOTDIR' ? 'a path component is not a directory' : 'no such file or directory' }
      }
      throw error
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`verified-read: "${current}" is a symbolic link; a path and its ancestors must be real entries inside ${root}`)
    }
    if (current === abs ? !stat.isFile() : !stat.isDirectory()) {
      throw new Error(`verified-read: "${current}" is not a regular ${current === abs ? 'file' : 'directory'}`)
    }
  }
  return { missing: false, abs }
}

/**
 * Read the file at `rel` under `root` as raw bytes, refusing anything but a
 * real regular file: the entry itself and every ancestor between `root` and it
 * must not be a symbolic link. A missing file, a directory in the file's place,
 * or any other non-regular entry fails loudly. The bytes are returned exactly
 * as stored — no decoding, no newline conversion.
 */
export async function readVerifiedFile(root: string, rel: string): Promise<Buffer> {
  const walked = await walkVerified(root, rel)
  if (walked.missing) {
    throw new Error(`verified-read: ${JSON.stringify(rel)} is missing under ${root} (${walked.reason})`)
  }
  return readFile(walked.abs)
}
