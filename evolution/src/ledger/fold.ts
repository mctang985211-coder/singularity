/**
 * Folding the append-only method ledger into the draft map: the one fold every
 * read path of this plane goes through. The four-state machine
 * (draft → evaluated → discarded | published) is enforced on every step, so one
 * wrong transition refuses the whole ledger rather than folding into a state no
 * sequence of legitimate records could produce.
 *
 * @module dsh-singularity-evolution/ledger/fold
 */

import type { DraftStatus, EvaluationPlan, MethodDraft, TrialResult } from '../types.ts'
import type { EvaluationReportRef, EvolutionRecordV5 } from './records.ts'

/** One draft as every read path of the new protocol sees it. */
export interface DraftView {
  draft: MethodDraft
  libraryId: string
  status: DraftStatus
  plan?: EvaluationPlan
  planDigest?: string
  evaluationId?: string
  storeId?: string
  reportPath?: string
  trials: TrialResult[]
  evaluation?: EvaluationReportRef
  discardReason?: string
  published?: { revisionId: string; supersededRevisionId: string | null; intentId: string; approvalRef?: string; at: string }
  rolledback?: { revisionId: string; supersededRevisionId: string | null; intentId: string; approvalRef?: string; at: string }
  /** Every record that moved this draft, oldest first — derived, never stored. */
  history: { kind: EvolutionRecordV5['kind']; actor: string; at: string }[]
}

function clockOf(record: EvolutionRecordV5): { actor: string; at: string } {
  if (record.kind === 'trial') return { actor: record.trial.actor, at: record.trial.at }
  return { actor: record.actor, at: record.at }
}

function require(current: DraftView | undefined, draftId: string, kind: string): DraftView {
  if (current === undefined) {
    throw new Error(`evolution: ledger record "${kind}" names unknown draft "${draftId}"; a draft record must come first`)
  }
  return current
}

function assertOpen(view: DraftView, kind: string): void {
  if (view.status === 'published') {
    throw new Error(
      `evolution: draft "${view.draft.draftId}" is published (revision "${view.published?.revisionId}"); a published draft takes no "${kind}" ` +
        'record — a rollback is its own record and a new candidate is a new draft',
    )
  }
  if (view.status === 'discarded') {
    throw new Error(`evolution: draft "${view.draft.draftId}" is discarded; a discarded draft takes no "${kind}" record`)
  }
}

/**
 * Fold the v5 ledger, enforcing the four-state machine on every step: one wrong
 * transition refuses the whole ledger rather than folding into a state no
 * sequence of legitimate records could produce.
 */
export function foldMethods(records: readonly EvolutionRecordV5[]): Map<string, DraftView> {
  const drafts = new Map<string, DraftView>()
  const trialKeys = new Set<string>()
  for (const record of records) {
    if (record.kind === 'draft') {
      if (drafts.has(record.draftId)) throw new Error(`evolution: draft "${record.draftId}" already exists`)
      drafts.set(record.draftId, {
        draft: {
          draftId: record.draftId,
          kind: record.assetKind,
          identity: record.identity,
          baseRevision: record.baseRevision,
          candidateRevision: record.candidateRevision,
          rationale: record.rationale,
          sourceRefs: [...record.sourceRefs],
          actor: record.actor,
          at: record.at,
        },
        libraryId: record.libraryId,
        status: 'draft',
        trials: [],
        history: [{ kind: record.kind, actor: record.actor, at: record.at }],
      })
      continue
    }
    if (record.kind === 'rolledback' && record.draftId === null) continue
    const draftId = record.draftId!
    const current = require(drafts.get(draftId), draftId, record.kind)
    const clock = clockOf(record)
    switch (record.kind) {
      case 'plan': {
        assertOpen(current, 'plan')
        if (current.plan !== undefined) {
          throw new Error(
            `evolution: draft "${draftId}" already carries the plan of evaluation "${current.evaluationId}"; one draft is one frozen plan`,
          )
        }
        if (record.plan.kind !== current.draft.kind) {
          throw new Error(
            `evolution: plan record for draft "${draftId}" freezes a "${record.plan.kind}" evaluation while the draft is "${current.draft.kind}"`,
          )
        }
        current.plan = record.plan
        current.planDigest = record.planDigest
        current.evaluationId = record.evaluationId
        current.reportPath = record.report
        if (record.storeId !== undefined) current.storeId = record.storeId
        break
      }
      case 'trial': {
        assertOpen(current, 'trial')
        if (current.plan === undefined) {
          throw new Error(`evolution: trial record for draft "${draftId}" precedes its plan record; a trial is one side of a frozen plan`)
        }
        if (record.evaluationId !== current.evaluationId) {
          throw new Error(
            `evolution: trial record for draft "${draftId}" belongs to evaluation "${record.evaluationId}", not to the frozen plan's ` +
              `"${current.evaluationId}"`,
          )
        }
        if (record.trial.sampleTaskId !== undefined && !current.plan.samples.some(sample => sample.taskId === record.trial.sampleTaskId)) {
          throw new Error(
            `evolution: trial record for draft "${draftId}" names sample "${record.trial.sampleTaskId}", which the frozen plan does not hold`,
          )
        }
        const key = `${record.evaluationId}\u0000${record.trial.sampleTaskId}\u0000${record.trial.side}`
        if (trialKeys.has(key)) {
          throw new Error(
            `evolution: trial record for sample "${record.trial.sampleTaskId}" ${record.trial.side} side of draft "${draftId}" is already ` +
              'recorded; one side of one sample settles once',
          )
        }
        trialKeys.add(key)
        current.trials.push(record.trial)
        break
      }
      case 'evaluation': {
        assertOpen(current, 'evaluation')
        if (current.plan === undefined) {
          throw new Error(`evolution: evaluation record for draft "${draftId}" precedes its plan record`)
        }
        if (record.evaluationId !== current.evaluationId) {
          throw new Error(
            `evolution: evaluation record for draft "${draftId}" names evaluation "${record.evaluationId}", not the plan's "${current.evaluationId}"`,
          )
        }
        if (current.evaluation !== undefined) {
          throw new Error(`evolution: draft "${draftId}" already carries the verdict of evaluation "${current.evaluationId}"`)
        }
        current.evaluation = {
          evaluationId: record.evaluationId,
          reportPath: record.report,
          reportDigest: record.reportDigest,
          verdict: record.verdict,
        }
        current.status = 'evaluated'
        break
      }
      case 'discard': {
        assertOpen(current, 'discard')
        current.discardReason = record.reason
        current.status = 'discarded'
        break
      }
      case 'published': {
        if (current.status !== 'evaluated') {
          throw new Error(
            `evolution: published record for draft "${draftId}" requires an evaluated draft (it is ${current.status}); the publish path ` +
              're-checks the report before it switches the pointer',
          )
        }
        current.published = {
          revisionId: record.revisionId,
          supersededRevisionId: record.supersededRevisionId,
          intentId: record.intentId,
          ...(record.approvalRef === undefined ? {} : { approvalRef: record.approvalRef }),
          at: record.at,
        }
        current.status = 'published'
        break
      }
      case 'rolledback': {
        if (current.status !== 'published') {
          throw new Error(
            `evolution: rolledback record for draft "${draftId}" requires a published draft (it is ${current.status}); a rollback restores ` +
              'the revision a publish superseded',
          )
        }
        current.rolledback = {
          revisionId: record.revisionId,
          supersededRevisionId: record.supersededRevisionId,
          intentId: record.intentId,
          ...(record.approvalRef === undefined ? {} : { approvalRef: record.approvalRef }),
          at: record.at,
        }
        break
      }
    }
    current.history.push({ kind: record.kind, actor: clock.actor, at: clock.at })
  }
  return drafts
}
