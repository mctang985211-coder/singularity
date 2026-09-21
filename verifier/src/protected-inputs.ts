/**
 * Protected acceptance inputs (KISS §4.3): the files a criterion's verdict
 * rests on — acceptance scripts, threshold files, fixtures — whose identity
 * the contract fixed at admission as `{ path, sha256 }`.
 *
 * The check here is a re-read, not a trust: the registry re-reads every
 * declared path against the directory the judge would run in and compares the
 * bytes' digest with the admitted one, so an input rewritten after admission
 * can never let a wrong product pass. Only declared paths are checked — a
 * criterion that declares none carries no protection, and none is invented
 * for it.
 */

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { sha256Hex } from '@dangosys/dsh-singularity-task'
import type { ProtectedInputRef } from '@dangosys/dsh-singularity-task'

/**
 * Every defect among `inputs`, read against `cwd`: the entry position and what
 * is wrong with it — malformed, missing, unreadable, or changed since
 * admission. Empty when every declared input is well formed, present, and
 * unchanged. Each message names the declared path (or the entry position, when
 * there is no path to name), so the caller never has to guess which input is at
 * fault.
 *
 * Entries are guarded before use. A criterion's `protectedInputs` reaches the
 * registry from the store, and admission is not the only writer: a direct store
 * write can hand over an entry admission would have refused, and the registry
 * still has to answer that criterion with a verdict. A malformed entry is a
 * defect of the verdict's inputs like any other — named in the refusal, never
 * thrown out of the judgement that was supposed to report it. The parameter
 * type stays the declared one; the runtime is what is not guaranteed.
 */
export async function protectedInputDefects(cwd: string, inputs: readonly ProtectedInputRef[]): Promise<string[]> {
  const defects: string[] = []
  for (const [index, entry] of inputs.entries()) {
    const input = entry as Partial<ProtectedInputRef> | null
    if (input === null || typeof input !== 'object') {
      defects.push(`protected input entry ${index} is malformed: expected an object with a path and a sha256`)
      continue
    }
    const path = input.path
    if (typeof path !== 'string' || path.trim().length === 0) {
      defects.push(`protected input entry ${index} is malformed: path must be a non-empty string`)
      continue
    }
    const admitted = input.sha256
    if (typeof admitted !== 'string' || admitted.trim().length === 0) {
      defects.push(`protected input entry ${index} is malformed: sha256 must be a non-empty string`)
      continue
    }
    let bytes: Buffer
    try {
      bytes = await readFile(resolve(cwd, path))
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      defects.push(`protected input "${path}" is missing or unreadable: ${reason}`)
      continue
    }
    const digest = sha256Hex(bytes)
    if (digest !== admitted) {
      defects.push(`protected input "${path}" changed since admission (admitted sha256 ${admitted}, now ${digest})`)
    }
  }
  return defects
}
