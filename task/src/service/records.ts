/** Evidence, handoff, review, diagnosis and obligation reducer handlers. @module @dangosys/dsh-singularity-task/service/records */

import { JUDGED_DIMENSIONS, JUDGEMENT_VERDICTS } from '../types.ts'
import type { Diagnosis, Obligation, ReviewRecord, RunId, TaskId, TaskSnapshot } from '../types.ts'
import { copy, nonEmpty, runIn, taskIn } from './checks/primitives.ts'

export function resolveCapabilities(
  snapshot: TaskSnapshot,
  taskId: TaskId,
  manifest: TaskSnapshot['capabilities'][string],
): TaskSnapshot {
  taskIn(snapshot, taskId)
  snapshot = { ...snapshot, capabilities: { ...snapshot.capabilities, [taskId]: copy(manifest) } }
  return snapshot
}

export function produceEvidence(
  snapshot: TaskSnapshot,
  taskId: TaskId,
  runId: RunId | undefined,
  evidence: TaskSnapshot['evidence'][number],
): TaskSnapshot {
  taskIn(snapshot, taskId)
  if (typeof evidence.evidenceId !== 'string' || evidence.evidenceId.length === 0)
    throw new Error('task: evidence id must be a non-empty string')
  if (snapshot.evidence.some(item => item.evidenceId === evidence.evidenceId)) {
    throw new Error(`task: evidence "${evidence.evidenceId}" already exists`)
  }
  if (evidence.taskId !== taskId)
    throw new Error(`task: evidence "${evidence.evidenceId}" does not belong to task "${taskId}"`)
  const run = runIn(snapshot, evidence.taskRunId)
  if (run.taskId !== taskId)
    throw new Error(`task: evidence "${evidence.evidenceId}" run "${run.runId}" belongs to task "${run.taskId}"`)
  if (runId !== undefined && runId !== evidence.taskRunId)
    throw new Error(`task: evidence "${evidence.evidenceId}" envelope run id mismatch`)
  if (run.status !== 'running') {
    throw new Error(`task: run "${run.runId}" is ${run.status}; evidence can only be recorded while the run is running`)
  }
  snapshot = {
    ...snapshot,
    evidence: [...snapshot.evidence, copy(evidence)],
    runs: snapshot.runs.map(item =>
      item.runId === run.runId
        ? {
            ...item,
            artifacts: [...item.artifacts, ...copy(evidence.artifacts)],
            verifierResults: [...item.verifierResults, ...copy(evidence.verifierResults)],
          }
        : item,
    ),
  }
  return snapshot
}

export function addHandoff(snapshot: TaskSnapshot, handoff: TaskSnapshot['handoffs'][number]): TaskSnapshot {
  if (typeof handoff.handoffId !== 'string' || handoff.handoffId.length === 0)
    throw new Error('task: handoff id must be a non-empty string')
  if (snapshot.handoffs.some(item => item.handoffId === handoff.handoffId)) {
    throw new Error(`task: handoff "${handoff.handoffId}" already exists`)
  }
  const parent = taskIn(snapshot, handoff.parentTaskId)
  const child = taskIn(snapshot, handoff.childTaskId)
  if (child.parentTaskId !== parent.taskId)
    throw new Error(`task: handoff child "${child.taskId}" is not a child of "${parent.taskId}"`)
  runIn(snapshot, handoff.parentRunId)
  snapshot = { ...snapshot, handoffs: [...snapshot.handoffs, copy(handoff)] }
  return snapshot
}

/** A review is the legal companion of the terminal transition it follows: the run (or the runless blocked task) must already sit in the outcome the record declares, and each run accepts exactly one record — a second one is a bug in the … */
export function recordReview(
  snapshot: TaskSnapshot,
  taskId: TaskId,
  envelopeRunId: RunId | undefined,
  review: ReviewRecord,
): TaskSnapshot {
  const task = taskIn(snapshot, taskId)
  if (review.taskId !== taskId)
    throw new Error(`task: review for "${review.taskId}" does not belong to task "${taskId}"`)
  if (
    review.outcome === 'failed' &&
    (typeof review.localizedCause !== 'string' || review.localizedCause.length === 0)
  ) {
    throw new Error(`task: failed review for task "${taskId}" requires a localized cause`)
  }
  if (review.outcome !== 'failed' && review.localizedCause !== undefined) {
    throw new Error(
      `task: review for task "${taskId}" is ${review.outcome}; only a failed outcome carries a localized cause`,
    )
  }
  if (review.outcome !== 'failed' && review.logTail !== undefined) {
    throw new Error(`task: review for task "${taskId}" is ${review.outcome}; only a failed outcome carries a log tail`)
  }
  if (review.outcome !== 'blocked' && review.blockedBy !== undefined) {
    throw new Error(`task: review for task "${taskId}" is ${review.outcome}; only a blocked outcome carries blockers`)
  }
  if (review.runId === undefined) {
    if (review.outcome !== 'blocked' || task.status !== 'blocked') {
      throw new Error(`task: review for task "${taskId}" has no run; only a blocked task settles without a run`)
    }
    if (snapshot.reviews.some(item => item.taskId === taskId && item.runId === undefined)) {
      throw new Error(`task: task "${taskId}" already has a runless review`)
    }
  } else {
    const run = runIn(snapshot, review.runId)
    if (run.taskId !== taskId) throw new Error(`task: review run "${run.runId}" belongs to task "${run.taskId}"`)
    if (envelopeRunId !== undefined && envelopeRunId !== review.runId) {
      throw new Error(`task: review for run "${review.runId}" envelope run id mismatch`)
    }
    if (run.status !== review.outcome) {
      throw new Error(
        `task: run "${run.runId}" is ${run.status}; a review must follow the terminal transition it declares (${review.outcome})`,
      )
    }
    if (snapshot.reviews.some(item => item.runId === review.runId)) {
      throw new Error(`task: run "${review.runId}" already has a review`)
    }
  }
  snapshot = { ...snapshot, reviews: [...snapshot.reviews, copy(review)] }
  return snapshot
}

/** A diagnosis is caller-triggered, not lifecycle-bound: any existing task accepts one at any time, and a task accumulates several. */
export function recordDiagnosis(snapshot: TaskSnapshot, taskId: TaskId, diagnosis: Diagnosis): TaskSnapshot {
  taskIn(snapshot, taskId)
  if (!nonEmpty(diagnosis.diagnosisId)) throw new Error('task: diagnosis id must be a non-empty string')
  if (snapshot.diagnoses.some(item => item.diagnosisId === diagnosis.diagnosisId)) {
    throw new Error(`task: diagnosis "${diagnosis.diagnosisId}" already exists`)
  }
  if (diagnosis.taskId !== taskId)
    throw new Error(`task: diagnosis for "${diagnosis.taskId}" does not belong to task "${taskId}"`)
  if (!nonEmpty(diagnosis.observedFailure))
    throw new Error(`task: diagnosis "${diagnosis.diagnosisId}" requires an observed failure`)
  if (!nonEmpty(diagnosis.scope)) throw new Error(`task: diagnosis "${diagnosis.diagnosisId}" requires a scope`)
  if (!nonEmpty(diagnosis.localizedCause))
    throw new Error(`task: diagnosis "${diagnosis.diagnosisId}" requires a localized cause`)
  if (!['high', 'medium', 'low'].includes(diagnosis.confidence)) {
    throw new Error(`task: diagnosis "${diagnosis.diagnosisId}" confidence must be high, medium, or low`)
  }
  if (
    !Array.isArray(diagnosis.evidenceRefs) ||
    !Array.isArray(diagnosis.reviewRefs) ||
    diagnosis.evidenceRefs.some(item => !nonEmpty(item)) ||
    diagnosis.reviewRefs.some(item => !nonEmpty(item))
  ) {
    throw new Error(`task: diagnosis "${diagnosis.diagnosisId}" refs must be arrays of non-empty strings`)
  }
  if (diagnosis.evidenceRefs.length + diagnosis.reviewRefs.length === 0) {
    throw new Error(`task: diagnosis "${diagnosis.diagnosisId}" must rest on at least one evidence or review ref`)
  }
  if (!Array.isArray(diagnosis.proposals))
    throw new Error(`task: diagnosis "${diagnosis.diagnosisId}" proposals must be an array`)
  for (const proposal of diagnosis.proposals) {
    if (!nonEmpty(proposal.targetType)) {
      throw new Error(`task: diagnosis "${diagnosis.diagnosisId}" proposal target type must be a non-empty string`)
    }
    if (!nonEmpty(proposal.targetId) || !nonEmpty(proposal.rationale)) {
      throw new Error(`task: diagnosis "${diagnosis.diagnosisId}" proposal requires a target id and a rationale`)
    }
  }
  if (diagnosis.producedBy !== undefined) {
    const provenance = diagnosis.producedBy
    if (provenance.kind !== 'agent' && provenance.kind !== 'human') {
      throw new Error(`task: diagnosis "${diagnosis.diagnosisId}" producedBy.kind must be "agent" or "human"`)
    }
    if (provenance.sessionId !== undefined && !nonEmpty(provenance.sessionId)) {
      throw new Error(`task: diagnosis "${diagnosis.diagnosisId}" producedBy.sessionId must be a non-empty string`)
    }
  }
  if (diagnosis.judgements !== undefined) {
    if (!Array.isArray(diagnosis.judgements)) {
      throw new Error(`task: diagnosis "${diagnosis.diagnosisId}" judgements must be an array`)
    }
    for (const judgement of diagnosis.judgements) {
      if (!JUDGED_DIMENSIONS.includes(judgement.dimension)) {
        throw new Error(
          `task: diagnosis "${diagnosis.diagnosisId}" judgement dimension must be one of ${JUDGED_DIMENSIONS.join(', ')}`,
        )
      }
      if (!JUDGEMENT_VERDICTS.includes(judgement.verdict)) {
        throw new Error(
          `task: diagnosis "${diagnosis.diagnosisId}" judgement verdict must be one of ${JUDGEMENT_VERDICTS.join(', ')}`,
        )
      }
      if (
        !Array.isArray(judgement.evidenceRefs) ||
        judgement.evidenceRefs.length === 0 ||
        judgement.evidenceRefs.some(item => !nonEmpty(item))
      ) {
        throw new Error(
          `task: diagnosis "${diagnosis.diagnosisId}" judgement "${judgement.dimension}" must rest on at least one non-empty evidence ref`,
        )
      }
      if (!nonEmpty(judgement.rationale)) {
        throw new Error(
          `task: diagnosis "${diagnosis.diagnosisId}" judgement "${judgement.dimension}" requires a rationale`,
        )
      }
    }
  }
  for (const related of diagnosis.relatedTaskIds ?? []) taskIn(snapshot, related)
  snapshot = { ...snapshot, diagnoses: [...snapshot.diagnoses, copy(diagnosis)] }
  return snapshot
}

/** An obligation is raised, never scheduled (KISS §5.1: a question, not an action): the reducer enforces integrity only — a unique non-empty id, non-empty goal and criterion, and a source task that exists in the store. */
export function recordObligation(snapshot: TaskSnapshot, obligation: Obligation): TaskSnapshot {
  if (!nonEmpty(obligation.obligationId)) throw new Error('task: obligation id must be a non-empty string')
  if (snapshot.obligations.some(item => item.obligationId === obligation.obligationId)) {
    throw new Error(`task: obligation "${obligation.obligationId}" already exists`)
  }
  if (!nonEmpty(obligation.goal)) throw new Error(`task: obligation "${obligation.obligationId}" requires a goal`)
  if (!nonEmpty(obligation.criterion))
    throw new Error(`task: obligation "${obligation.obligationId}" requires a criterion`)
  taskIn(snapshot, obligation.sourceTaskId)
  snapshot = { ...snapshot, obligations: [...snapshot.obligations, copy(obligation)] }
  return snapshot
}
