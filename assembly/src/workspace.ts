/**
 * Preparing a task's workspace: the protected material a run is judged against, and the starting point
 * it is judged on.
 *
 * The bytes come from the loader, never from a path. `Domain.inputs[].digest` and `Domain.initial` are
 * computed over the domain's own bytes at load and the run is bound to those digests, so staging by
 * re-reading the source would let a file that changed under a running deployment produce a workspace
 * that does not hash to what the run declares — a mismatch discovered later, at judgement time, as if
 * the workspace were at fault. Enforcing the submission shape is the caller's rule: this module only
 * guarantees that what the domain declares is on disk before work starts.
 *
 * @module @dangosys/dsh-singularity-next/workspace
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { refuse } from '../../src/protocol/refusal.ts'
import type { Domain } from './domain.ts'

/** One path inside the workspace, made absolute. Never a bare name: the domain's paths are relative. */
export const workspacePathOf = (workspace: string, relative: string): string => join(workspace, relative)

/**
 * Stage a task's workspace: every declared input, then the initial source of a `source` submission.
 *
 * Idempotent, because a boot re-prepares the workspaces of tasks whose runs are still in flight
 * (`repair`), and rewriting identical bytes is not a change. A submission that already replaced the
 * initial source is **not** overwritten: the artifact the run was judged on is the one on disk, and
 * restoring the seed under it would make a settled attempt's artifact disagree with its own digest.
 */
export async function prepareWorkspace(domain: Domain, workspace: string): Promise<void> {
  for (const input of domain.inputs) {
    const target = workspacePathOf(workspace, input.path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, input.bytes)
  }
  if (domain.initial === undefined) return
  const seed = workspacePathOf(workspace, domain.file)
  await mkdir(dirname(seed), { recursive: true })
  // `wx` is the whole of the "do not overwrite a submission" rule, in the one place that can decide it
  // without reading the file twice: the create fails if anything is already there.
  await writeFile(seed, domain.initial.bytes, { flag: 'wx' }).catch((error: unknown) => {
    if ((error as { code?: string }).code === 'EEXIST') return
    refuse('write-not-durable', `the initial source of task workspace "${workspace}" could not be written: ${error instanceof Error ? error.message : String(error)}`)
  })
}
