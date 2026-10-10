/**
 * Preparing a task's workspace: the protected material a run is judged against, and the starting point it
 * is judged on.
 *
 * The bytes come from the loader, never from a path: the digests the run is bound to were computed over
 * those bytes at load, so re-reading the source could stage something that does not hash to what the run
 * declares — a mismatch found later, at judgement time, as if the workspace were at fault.
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
 * Idempotent, because a boot re-prepares the workspaces of in-flight runs and rewriting identical bytes
 * is not a change — but a submission that already replaced the initial source is *not* overwritten:
 * restoring the seed would make a settled attempt's artifact disagree with its own digest.
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
