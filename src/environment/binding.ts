/**
 * The binding a run records, resolved against the revisions the log actually created.
 *
 * A run pins an environment, a revision id and a content digest. The reducer that recorded the run
 * could not check that the revision exists: the run is a fact of its task's subject, while the
 * revision is a fact of the environment's subject, and one subject's reducer never sees another's
 * facts. So this is the documented cross-subject seam: the existence check is a **projection**, and
 * it **refuses by name** rather than reporting a shortfall.
 *
 * "Report, don't refuse" is wrong here because the caller is not asking for a summary — it is
 * resolving the one revision an execution is pinned to. A projection that skipped an unbindable run
 * would hand back a list that looks complete while a run in it has no revision, and the caller
 * would have no way to tell. The refusal names the run and the environment state it was checked
 * against, so the missing creation is visible as a missing fact.
 *
 * All three ways a pin can fail to resolve are `unknown-revision`: the environment is absent, the
 * revision id is absent from it, or the recorded content digest is not the pinned one. They are one
 * code because the caller's next move is the same for all three — the run's pin does not name a
 * revision this log holds.
 *
 * @module singularity-core/environment/binding
 */

import { refuse } from '../protocol/refusal.ts'
import type { EnvironmentState, RevisionState } from './protocol.ts'

/**
 * Resolve the revision a run is pinned to, or refuse by name.
 *
 * The digest must match: an id alone can be re-pointed by later content, which is exactly what
 * content addressing exists to prevent. The returned revision is the *created* one, so a caller
 * reads the recorded manifest and never a caller-supplied copy of it.
 */
export function assertPinnedRevision(
  pin: Readonly<{ environmentId: string; revisionId: string; digest: string }>,
  environments: ReadonlyMap<string, EnvironmentState>,
  where: string,
): RevisionState {
  const environment = environments.get(pin.environmentId)
  if (environment === undefined)
    refuse(
      'unknown-revision',
      `${where} pins environment "${pin.environmentId}", which no revision/created fact created (created environments: ${
        [...environments.keys()].sort().join(', ') || 'none'
      })`,
    )

  const revision = Object.hasOwn(environment.revisions, pin.revisionId)
    ? environment.revisions[pin.revisionId]
    : undefined
  if (revision === undefined)
    refuse(
      'unknown-revision',
      `${where} pins revision "${pin.revisionId}" of environment "${pin.environmentId}", which that environment never created (created revisions: ${
        Object.keys(environment.revisions).sort().join(', ') || 'none'
      })`,
    )

  if (revision.contentDigest !== pin.digest)
    refuse(
      'unknown-revision',
      `${where} pins revision "${pin.revisionId}" of environment "${pin.environmentId}" at content digest ${pin.digest.slice(
        0,
        12,
      )}… but the created revision reads ${revision.contentDigest.slice(0, 12)}…; a pin names content, not just an id`,
    )

  return revision
}

/**
 * Resolve every run's pin, in order. The first run that cannot be bound refuses the whole
 * projection: a partial list would be read as a complete one.
 */
export function projectBindings(
  runs: readonly Readonly<{
    runId: string
    revision: Readonly<{ environmentId: string; revisionId: string; digest: string }>
  }>[],
  environments: ReadonlyMap<string, EnvironmentState>,
): readonly { runId: string; environmentId: string; revisionId: string; contentDigest: string }[] {
  return runs.map(run => {
    const revision = assertPinnedRevision(run.revision, environments, `run "${run.runId}"`)
    return {
      runId: run.runId,
      environmentId: run.revision.environmentId,
      revisionId: run.revision.revisionId,
      contentDigest: revision.contentDigest,
    }
  })
}
