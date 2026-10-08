/**
 * The coordination plane's facts, handed to the one read model that owns
 * progress: this module maps rows to the wire `context` reduces, and answers the
 * review pack's question about one diagnosis. It derives no progress itself —
 * `context/src/view/facts.ts:deriveProgress` is the only place a phase exists.
 *
 * @module @dangosys/dsh-singularity-agent/coordination/facts-reader
 */

import type { CoordinationAssignmentFacts, CoordinationCompletionFacts, CoordinationFactsReader } from '@dangosys/dsh-singularity-context'
import { readCoordinationRows, workOf, type CoordinatedWork, type CoordinationRow } from './store.ts'
import { roundDiagnosisId } from './rounds.ts'

/** The completion facts one row carries, in the wire shape the read model reduces. */
function completionFacts(row: CoordinationRow): CoordinationCompletionFacts | undefined {
  if (row.kind !== 'completion' || row.result.kind !== 'completed') return undefined
  const result = row.result
  return {
    businessAction: result.businessAction,
    searchNext: result.searchNext,
    methodDecision: result.methodDecision,
    reason: result.reason,
    evidenceRefs: result.evidenceRefs,
    ...(result.trialCandidateRef === null ? {} : { trialCandidateRef: result.trialCandidateRef }),
    ...(result.approval === undefined
      ? {}
      : { approval: { kind: result.approval.source, actor: result.approval.ref } }),
    at: row.at,
  }
}

/** One work item's state in the read model's vocabulary. */
function stateOf(work: CoordinatedWork): CoordinationAssignmentFacts['state'] {
  const completion = work.completion
  if (completion === undefined) return 'open'
  return completion.result.kind === 'completed' || completion.result.kind === 'reviewed' ? 'settled' : 'interrupted'
}

/**
 * The round work items one store holds, as the read model reduces them. A review
 * work item is not a round: it is read through `workForDiagnosis` and the review
 * pack, never counted into the round a graph reports.
 */
export function assignmentFactsOf(
  rows: readonly CoordinationRow[],
  storeId: string,
): readonly CoordinationAssignmentFacts[] {
  const graphIds = [...new Set(rows.filter(row => row.storeId === storeId).map(row => row.graphId))]
  const facts: CoordinationAssignmentFacts[] = []
  for (const graphId of graphIds) {
    for (const work of workOf(rows, graphId)) {
      const assignment = work.assignment
      if (assignment.storeId !== storeId || assignment.role !== 'supervisor') continue
      if (assignment.subject.kind !== 'round') continue
      const completion = work.completion === undefined ? undefined : completionFacts(work.completion)
      facts.push({
        assignmentId: assignment.sessionId,
        role: 'supervisor',
        round: assignment.subject.businessRound,
        sessionId: assignment.sessionId,
        sourceTaskId: assignment.subject.source.taskId,
        sourceRunId: assignment.subject.source.runId,
        state: stateOf(work),
        ...(completion === undefined ? {} : { completion }),
      })
    }
  }
  return facts.sort((left, right) => (left.round < right.round ? -1 : left.round > right.round ? 1 : 0))
}

/** The read model's one coordination fact producer, read straight from the store. */
export function coordinationFactsReader(): CoordinationFactsReader {
  return {
    async assignments(graphKey: string) {
      const rows = (await readCoordinationRows()) ?? []
      return assignmentFactsOf(rows, graphKey)
    },
  }
}

/** The diagnosis id one round assignment is supervised under, or `undefined` for a review assignment. */
export function diagnosisIdOf(assignment: CoordinatedWork['assignment']): string | undefined {
  if (assignment.subject.kind !== 'round') return undefined
  return roundDiagnosisId(assignment.graphId, assignment.epoch, assignment.subject.businessRound)
}

/** The supervision work items one round's diagnosis left, filtered from work a caller already read. */
export function workOfDiagnosis(work: readonly CoordinatedWork[], diagnosisId: string): readonly CoordinatedWork[] {
  return work.filter(item => diagnosisIdOf(item.assignment) === diagnosisId)
}

/** The review work items of one exact source, filtered from work a caller already read. */
export function workOfSource(
  work: readonly CoordinatedWork[],
  source: { readonly taskId: string; readonly runId: string | null },
): readonly CoordinatedWork[] {
  return work.filter(item => {
    const subject = item.assignment.subject
    if (subject.kind !== 'review') return false
    return subject.source.taskId === source.taskId && subject.source.runId === source.runId
  })
}

/** The supervision work items one round's diagnosis left, for `task_review_pack`. */
export async function workForDiagnosis(graphId: string, diagnosisId: string): Promise<readonly CoordinatedWork[]> {
  const rows = (await readCoordinationRows()) ?? []
  return workOfDiagnosis(workOf(rows, graphId), diagnosisId)
}
