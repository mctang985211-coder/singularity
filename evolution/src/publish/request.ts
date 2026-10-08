/**
 * The publish request: one evaluated draft translated into one pointer switch.
 * This module owns no bytes — the revision directory already holds them; the
 * only thing a publish moves is the environment pointer.
 */

import type { EnvironmentRevision, EnvironmentPublishSource } from '@dangosys/dsh-singularity-task-runtime'
import type { DraftView } from '../ledger/fold.ts'
import type { MethodDraft } from '../types.ts'

/** The active pointer as every reader of this plane sees it (the runtime's own projection). */
export interface PointerState {
  readonly revisionId: string
  /** The pointer's generation: the second half of the compare-and-swap pair. */
  readonly generation: number
  readonly manifestDigest: string
}

/** The environment reads a publish plan is built from. */
export interface PublishSources {
  readonly libraryId: string
  readonly pointer: () => Promise<PointerState>
  readonly revision: (revisionId: string) => Promise<EnvironmentRevision>
}

/** One pointer switch, fully specified before anything moves. */
export interface EnvironmentPublishPlan {
  readonly draftId: string
  readonly direction: 'apply' | 'rollback'
  readonly source: EnvironmentPublishSource
  readonly candidateDigest: string
  readonly baselineRevisionId: string
  readonly expected: { readonly revisionId: string; readonly generation: number }
  readonly approvalRef: string
  readonly actor: string
}

/** The preconditions a publish needs of the draft itself, before the pointer is read. */
export function assertPublishable(view: DraftView, direction: 'apply' | 'rollback'): void {
  const draftId = view.draft.draftId
  if (direction === 'apply') {
    if (view.status !== 'evaluated') {
      throw new Error(
        `evolution: draft "${draftId}" is ${view.status}; only an evaluated draft may be published — an unevaluated candidate has no report ` +
          'for the pre-publish re-check to re-read',
      )
    }
    if (view.evaluation === undefined) {
      throw new Error(`evolution: draft "${draftId}" is evaluated but records no report; nothing may be published from it`)
    }
    return
  }
  if (view.status !== 'published') {
    throw new Error(
      `evolution: draft "${draftId}" is ${view.status}; only a published draft may be rolled back — a rollback restores the revision its ` +
        'publish superseded',
    )
  }
  if (view.published?.supersededRevisionId == null) {
    throw new Error(
      `evolution: draft "${draftId}" was published over no revision (its publish superseded nothing), so there is no revision to roll back to`,
    )
  }
}

/**
 * Build the one plan a publish or rollback runs: the pointer's exact expected
 * state, the revision to switch to, and the digest that revision holds.
 */
export async function buildPublishPlan(
  sources: PublishSources,
  draft: MethodDraft,
  direction: 'apply' | 'rollback',
  actor: string,
  approvalRef: string,
): Promise<EnvironmentPublishPlan> {
  const pointer = await sources.pointer()
  if (sources.libraryId !== draft.baseRevision.libraryId) {
    throw new Error(
      `evolution: draft "${draft.draftId}" belongs to library "${draft.baseRevision.libraryId}" but this host serves "${sources.libraryId}"`,
    )
  }
  const expected = { revisionId: pointer.revisionId, generation: pointer.generation }
  if (direction === 'apply') {
    if (draft.candidateRevision.digest.length === 0) {
      throw new Error(`evolution: draft "${draft.draftId}" names an empty candidate digest; there is nothing to publish`)
    }
    const candidate = await sources.revision(draft.candidateRevision.revisionId)
    if (candidate.manifest.contentDigest !== draft.candidateRevision.digest) {
      throw new Error(
        `evolution: draft "${draft.draftId}" freezes candidate digest ${draft.candidateRevision.digest}, but revision ` +
          `"${candidate.manifest.revisionId}" reads ${candidate.manifest.contentDigest} — the candidate moved since it was evaluated`,
      )
    }
    return {
      draftId: draft.draftId,
      direction,
      source: { kind: 'draft', draftId: draft.draftId },
      candidateDigest: candidate.manifest.contentDigest,
      baselineRevisionId: pointer.revisionId,
      expected,
      approvalRef,
      actor,
    }
  }
  const target = await sources.revision(draft.baseRevision.revisionId)
  return {
    draftId: draft.draftId,
    direction,
    source: { kind: 'revision', revisionId: target.manifest.revisionId },
    candidateDigest: target.manifest.contentDigest,
    baselineRevisionId: pointer.revisionId,
    expected,
    approvalRef,
    actor,
  }
}

/** One plan as the runtime's own publish request: the CAS pair, the source and the actor. */
export function publishRequestOf(plan: EnvironmentPublishPlan): import('@dangosys/dsh-singularity-task-runtime').PublishRequest {
  return {
    direction: plan.direction === 'apply' ? 'publish' : 'rollback',
    source: plan.source,
    expected: { revisionId: plan.expected.revisionId, generation: plan.expected.generation },
    ...(plan.approvalRef.length === 0 ? {} : { approvalRef: plan.approvalRef }),
    actor: plan.actor,
  }
}
