/**
 * The publish driver: a draft's pointer switch and its completion record. The
 * environment pointer is the only thing a publish moves; this module asks the
 * runtime for the switch and writes the ledger line that records it.
 */

import type {
  EnvironmentPointerCompletion,
  EnvironmentPointerReconcile,
  EnvironmentRevision,
  PublishOutcome,
  PublishRequest,
} from '@dangosys/dsh-singularity-task-runtime'
import type { DraftView } from '../ledger/fold.ts'
import { foldMethods } from '../ledger/fold.ts'
import type { EvolutionRecordV5 } from '../ledger/records.ts'
import { assertPublishable, buildPublishPlan, publishRequestOf } from './request.ts'
import type { PointerState } from './request.ts'

/** The ledger this driver appends its completions to. */
export interface PublishLedger {
  readonly libraryId: string
  records(): readonly EvolutionRecordV5[]
  append(record: EvolutionRecordV5): Promise<void>
}

/** The runtime's own environment surface, as the publish path uses it. */
export interface PublishRuntime {
  /** The active pointer: the compare-and-swap pair plus the revision's manifest digest. */
  activePointer(sessionId: string): Promise<PointerState>
  /** One frozen revision of this library, by id; refuses an id the library does not hold. */
  revision(sessionId: string, revisionId: string): Promise<EnvironmentRevision>
  publish(sessionId: string, request: PublishRequest): Promise<PublishOutcome>
  rollback(sessionId: string, request: PublishRequest): Promise<PublishOutcome>
  /** Settle any pointer intent a killed process left open. */
  reconcile(sessionId: string): Promise<EnvironmentPointerReconcile[]>
  completions(sessionId: string): Promise<readonly EnvironmentPointerCompletion[]>
}

/** Everything one publish runs on. */
export interface PublishHost {
  readonly caller: string
  readonly ledger: PublishLedger
  readonly runtime: PublishRuntime
  /**
   * The pre-publish re-check (`validateEvaluation(mode:'pre-publish')`), run
   * before the pointer is read so a candidate the report no longer supports is
   * refused while nothing has moved.
   */
  validatePrePublish?(view: DraftView): Promise<void>
}

function viewOf(host: PublishHost, draftId: string): DraftView {
  const view = foldMethods(host.ledger.records()).get(draftId)
  if (view === undefined) throw new Error(`evolution: unknown draft "${draftId}"`)
  return view
}

/** The ledger line one successful pointer switch leaves: the publish completion. */
function publishedRecord(input: {
  draftId: string
  revisionId: string
  supersededRevisionId: string | null
  intentId: string
  approvalRef: string
  actor: string
  at: string
}): EvolutionRecordV5 {
  return {
    formatVersion: 5,
    kind: 'published',
    draftId: input.draftId,
    revisionId: input.revisionId,
    supersededRevisionId: input.supersededRevisionId,
    intentId: input.intentId,
    ...(input.approvalRef.length === 0 ? {} : { approvalRef: input.approvalRef }),
    actor: input.actor,
    at: input.at,
  }
}

/** The ledger line one successful rollback leaves. */
function rolledbackRecord(input: {
  draftId: string | null
  revisionId: string
  supersededRevisionId: string | null
  intentId: string
  approvalRef: string
  actor: string
  at: string
}): EvolutionRecordV5 {
  return {
    formatVersion: 5,
    kind: 'rolledback',
    draftId: input.draftId,
    revisionId: input.revisionId,
    supersededRevisionId: input.supersededRevisionId,
    intentId: input.intentId,
    ...(input.approvalRef.length === 0 ? {} : { approvalRef: input.approvalRef }),
    actor: input.actor,
    at: input.at,
  }
}

/**
 * Publish one evaluated draft: re-check the report, switch the pointer with the
 * pointer's own expected state, then record the completion. A pointer a third
 * party moved makes the runtime refuse the CAS, and nothing is recorded.
 */
export async function publishDraftEnvironment(
  host: PublishHost,
  draftId: string,
  actor: string,
  approvalRef: string,
): Promise<PublishOutcome> {
  const view = viewOf(host, draftId)
  assertPublishable(view, 'apply')
  if (host.validatePrePublish !== undefined) await host.validatePrePublish(view)
  const plan = await buildPublishPlan(
    {
      libraryId: host.ledger.libraryId,
      pointer: () => host.runtime.activePointer(host.caller),
      revision: revisionId => host.runtime.revision(host.caller, revisionId),
    },
    view.draft,
    'apply',
    actor,
    approvalRef,
  )
  const outcome = await host.runtime.publish(host.caller, publishRequestOf(plan))
  await host.ledger.append(
    publishedRecord({
      draftId,
      revisionId: outcome.pointer.revisionId,
      supersededRevisionId: outcome.supersededRevisionId,
      intentId: outcome.completion.intentId,
      approvalRef,
      actor,
      at: new Date().toISOString(),
    }),
  )
  return outcome
}

/**
 * Roll one published draft back: the pointer returns to the revision its publish
 * superseded, through the same compare-and-swap transaction.
 */
export async function rollbackDraftEnvironment(
  host: PublishHost,
  draftId: string,
  actor: string,
  approvalRef: string,
): Promise<PublishOutcome> {
  const view = viewOf(host, draftId)
  assertPublishable(view, 'rollback')
  const plan = await buildPublishPlan(
    {
      libraryId: host.ledger.libraryId,
      pointer: () => host.runtime.activePointer(host.caller),
      revision: revisionId => host.runtime.revision(host.caller, revisionId),
    },
    view.draft,
    'rollback',
    actor,
    approvalRef,
  )
  const outcome = await host.runtime.rollback(host.caller, publishRequestOf(plan))
  await host.ledger.append(
    rolledbackRecord({
      draftId,
      revisionId: outcome.pointer.revisionId,
      supersededRevisionId: outcome.supersededRevisionId,
      intentId: outcome.completion.intentId,
      approvalRef,
      actor,
      at: new Date().toISOString(),
    }),
  )
  return outcome
}

/**
 * Fold the pointer's own completions back into the ledger: a switch that landed
 * before the process died gets its line. A completion whose revision matches no
 * draft is reported as blocked rather than invented onto one.
 */
export async function reconcilePublishes(host: PublishHost): Promise<EnvironmentPointerReconcile[]> {
  const reconcile = await host.runtime.reconcile(host.caller)
  const completions = await host.runtime.completions(host.caller)
  const records = [...host.ledger.records()]
  const recorded = new Set(records.flatMap(record => (record.kind === 'published' || record.kind === 'rolledback' ? [record.intentId] : [])))
  const drafts = foldMethods(records as EvolutionRecordV5[])
  const byRevision = new Map<string, string>()
  for (const view of drafts.values()) {
    byRevision.set(view.draft.candidateRevision.revisionId, view.draft.draftId)
    byRevision.set(view.draft.baseRevision.revisionId, view.draft.draftId)
  }
  for (const completion of completions) {
    if (recorded.has(completion.intentId)) continue
    const draftId = byRevision.get(completion.revisionId) ?? null
    if (completion.direction === 'publish' && draftId === null) {
      reconcile.push({
        intentId: completion.intentId,
        direction: 'publish',
        result: 'blocked',
        revisionId: completion.revisionId,
        detail: `no draft of library "${host.ledger.libraryId}" names revision "${completion.revisionId}", so the completion has no draft to close`,
      })
      continue
    }
    await host.ledger.append(
      completion.direction === 'publish'
        ? publishedRecord({
            draftId: draftId!,
            revisionId: completion.revisionId,
            supersededRevisionId: completion.supersededRevisionId,
            intentId: completion.intentId,
            approvalRef: completion.approvalRef ?? '',
            actor: completion.actor,
            at: completion.at,
          })
        : rolledbackRecord({
            draftId,
            revisionId: completion.revisionId,
            supersededRevisionId: completion.supersededRevisionId,
            intentId: completion.intentId,
            approvalRef: completion.approvalRef ?? '',
            actor: completion.actor,
            at: completion.at,
          }),
    )
  }
  return reconcile
}
