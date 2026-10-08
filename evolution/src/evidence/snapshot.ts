/**
 * The frozen input both sides are built from. The workspace builder and the
 * recursive input digest are the experiment generation's own proven ones; this
 * module is the new path's single import point for them, so the move happens
 * once, when the old evaluation machinery is deleted.
 */

import { resolve } from 'node:path'
import { buildWorkspace } from '../experiment/workspace.ts'
import { directoryDigest } from '../experiment/record.ts'
import { normalizeSnapshot } from '../replay/snapshot.ts'
import type { PlannedInput } from '../types.ts'

export { buildWorkspace, directoryDigest }

/** The snapshot one evaluation freezes: a directory, optional paths and the digest every side is checked against. */
export interface InputSnapshot {
  readonly sourceDir: string
  readonly paths?: readonly string[]
  readonly rebaseFrom?: string
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
