/**
 * The two completion payloads a coordination session may send, the checks they
 * must pass before anything is written, and the rows they become. The fields a
 * model may state are only ever the ones it observed; what the platform derived
 * (the method decision, the search step, the approval source) is passed in
 * separately and is never an argument a model can send.
 *
 * @module @dangosys/dsh-singularity-agent/coordination/completion
 */

import {
  JUDGED_DIMENSIONS,
  JUDGEMENT_VERDICTS,
  type Diagnosis,
  type DiagnosisConfidence,
  type DiagnosisProposal,
  type JudgementVerdict,
  type ReviewJudgement,
  type TaskSnapshot,
} from '@dangosys/dsh-singularity-task'
import { reviewRef } from './identity.ts'
import type { CompletionApproval, CoordinationBinding, CoordinationCompletion } from './store.ts'

/** What a supervisor may ask the platform to do next with the business work. */
export type BusinessAction = 'continue' | 'recover' | 'finish'

/** `supervisor_complete`'s payload — exactly the tool's parameters. */
export interface SupervisorCompletionPayload {
  readonly businessAction: BusinessAction
  readonly reason: string
  readonly evidenceRefs: readonly string[]
  readonly trialCandidateRef?: string
}

/** `reviewer_complete`'s payload: the diagnosis fields, before validation. */
export interface ReviewCompletionPayload {
  readonly observation: string
  readonly conclusion: string
  readonly confidence: DiagnosisConfidence
  readonly scope?: string
  readonly reviewRefs?: readonly string[]
  readonly evidenceRefs?: readonly string[]
  readonly relatedTaskIds?: readonly string[]
  readonly judgements?: readonly {
    readonly dimension?: unknown
    readonly verdict?: unknown
    readonly evidenceRefs?: unknown
    readonly rationale?: unknown
  }[]
  readonly proposals?: readonly { readonly targetType?: unknown; readonly targetId?: unknown; readonly rationale?: unknown }[]
}

/** The outcome of validating one payload: what was accepted, or why nothing was written. */
export type CompletionValidation<Payload> =
  | { readonly ok: true; readonly payload: Payload }
  | { readonly ok: false; readonly refusal: string }

/** What the platform derived from the round's own method records; a model has no parameter for any of it. */
export interface DerivedCompletionFacts {
  readonly methodDecision: 'retain' | 'trial' | 'promote' | 'discard' | 'rollback'
  readonly searchNext: 'explore' | 'stop'
  readonly approval?: CompletionApproval
}

/** A non-empty string, or nothing. */
function textOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

/** The refs a store can resolve: reviews by `taskId#runId`, evidence bundles by id, criteria by id. */
export function knownReferences(snapshot: TaskSnapshot): ReadonlySet<string> {
  const known = new Set<string>()
  for (const review of snapshot.reviews) known.add(reviewRef(review))
  for (const evidence of snapshot.evidence) known.add(evidence.evidenceId)
  for (const task of snapshot.tasks) for (const criterion of task.acceptanceCriteria) known.add(criterion.criterionId)
  return known
}

/** The refs a judgement may cite: the recorded reviews, evidence, sessions and review lineage already on the store. */
function knownJudgementReferences(snapshot: TaskSnapshot): ReadonlySet<string> {
  const known = new Set<string>(knownReferences(snapshot))
  for (const review of snapshot.reviews) for (const ref of review.evidenceRefs) known.add(ref)
  for (const run of snapshot.runs) if (run.sessionId !== undefined) known.add(run.sessionId)
  for (const review of snapshot.reviews) if (review.sessionId !== undefined) known.add(review.sessionId)
  return known
}

/** Validate a supervisor's completion: the payload's own shape, and the evidence it rests on. */
export function validateSupervisorCompletion(input: {
  readonly binding: CoordinationBinding
  readonly snapshot: TaskSnapshot
  readonly outcome: 'verified' | 'failed'
  readonly payload: SupervisorCompletionPayload
}): CompletionValidation<SupervisorCompletionPayload> {
  const { payload, snapshot, binding } = input
  if (payload.businessAction !== 'continue' && payload.businessAction !== 'recover' && payload.businessAction !== 'finish')
    return { ok: false, refusal: `businessAction "${String(payload.businessAction)}" is not continue | recover | finish` }
  const reason = textOf(payload.reason)
  if (reason === undefined) return { ok: false, refusal: 'reason must be non-empty free text' }
  if (!Array.isArray(payload.evidenceRefs) || payload.evidenceRefs.length === 0)
    return { ok: false, refusal: 'evidenceRefs must name at least one recorded reference' }
  if (payload.trialCandidateRef !== undefined && textOf(payload.trialCandidateRef) === undefined)
    return { ok: false, refusal: 'trialCandidateRef must be a non-empty candidate id, or omitted' }
  if (binding.subject.kind !== 'round')
    return { ok: false, refusal: 'this session was not assigned a round; supervisor_complete concludes a round' }
  const run = snapshot.runs.find(candidate => candidate.runId === binding.subject.source.runId)
  if (run === undefined)
    return {
      ok: false,
      refusal: `this session's assigned source run "${binding.sourceRunId ?? '(none)'}" is not in store ${binding.rootStoreId}`,
    }
  const known = knownReferences(snapshot)
  const unknown = [...new Set(payload.evidenceRefs)].filter(ref => !known.has(ref))
  if (unknown.length > 0)
    return { ok: false, refusal: `evidenceRefs cite ${unknown.join(', ')}, which store ${binding.rootStoreId} does not hold` }
  return { ok: true, payload: { ...payload, reason, evidenceRefs: [...new Set(payload.evidenceRefs)] } }
}

/** The non-empty strings of an unknown value, or nothing at all. */
function nonEmptyStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0)
}

/** Validate the judgements the reviewer chose to make. Each one has to name a judged dimension and a verdict from the fixed vocabulary, cite at least one non-empty ref and carry a rationale. */
function judgementsOf(value: ReviewCompletionPayload['judgements'], known: ReadonlySet<string>): ReviewJudgement[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error('the "judgements" field is not an array')
  return value.map((entry, index) => {
    const dimension = entry.dimension
    if (!JUDGED_DIMENSIONS.includes(dimension as never))
      throw new Error(`judgement ${index} names dimension "${String(dimension)}", which is not one of ${JUDGED_DIMENSIONS.join(', ')}`)
    const verdict = entry.verdict
    if (!JUDGEMENT_VERDICTS.includes(verdict as JudgementVerdict))
      throw new Error(`judgement ${index} (${String(dimension)}) has verdict "${String(verdict)}", which is not adequate/inadequate/unknown`)
    const refs = nonEmptyStrings(entry.evidenceRefs)
    if (refs.length === 0)
      throw new Error(`judgement ${index} (${String(dimension)}) cites no evidence — a conclusion that rests on nothing is not recorded`)
    const unresolvable = refs.filter(ref => !known.has(ref))
    if (unresolvable.length > 0)
      throw new Error(`judgement ${index} (${String(dimension)}) cites ${unresolvable.join(', ')}, which this store does not hold`)
    const rationale = textOf(entry.rationale)
    if (rationale === undefined) throw new Error(`judgement ${index} (${String(dimension)}) carries no rationale`)
    return {
      dimension: dimension as ReviewJudgement['dimension'],
      verdict: verdict as JudgementVerdict,
      evidenceRefs: refs,
      rationale,
    }
  })
}

/** Validate the reviewer's proposals: a target name, an id and a reason, each non-empty. */
function proposalsOf(value: ReviewCompletionPayload['proposals']): DiagnosisProposal[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error('the "proposals" field is not an array')
  return value.map((entry, index) => {
    const targetType = textOf(entry.targetType)
    const targetId = textOf(entry.targetId)
    const rationale = textOf(entry.rationale)
    if (targetType === undefined || targetId === undefined || rationale === undefined)
      throw new Error(`proposal ${index} needs a non-empty targetType, targetId and rationale`)
    return { targetType, targetId, rationale }
  })
}

/** The distinct non-empty strings of an optional ref list, or nothing. */
function optionalRefs(value: readonly string[] | undefined, field: string): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some(ref => textOf(ref) === undefined))
    throw new Error(`the "${field}" field must be an array of non-empty strings`)
  return [...new Set(value)]
}

/** Validate a reviewer's completion and build the diagnosis it records. */
export function validateReviewCompletion(input: {
  readonly binding: CoordinationBinding
  readonly snapshot: TaskSnapshot
  readonly payload: ReviewCompletionPayload
}): CompletionValidation<{ readonly diagnosis: Diagnosis }> {
  const { payload, snapshot, binding } = input
  const observation = textOf(payload.observation)
  if (observation === undefined) return { ok: false, refusal: 'observation must be the non-empty postmortem observation' }
  const conclusion = textOf(payload.conclusion)
  if (conclusion === undefined) return { ok: false, refusal: 'conclusion must be non-empty free text' }
  if (payload.confidence !== 'high' && payload.confidence !== 'medium' && payload.confidence !== 'low')
    return { ok: false, refusal: `confidence "${String(payload.confidence)}" is not high/medium/low` }
  if (binding.subject.kind !== 'review')
    return { ok: false, refusal: 'this session was not assigned a review; reviewer_complete concludes a review' }
  const source = binding.subject.source
  const task = snapshot.tasks.find(candidate => candidate.taskId === source.taskId)
  if (task === undefined)
    return { ok: false, refusal: `this session's assigned source task "${source.taskId}" is not in store ${binding.rootStoreId}` }
  const review = snapshot.reviews.find(
    item => item.taskId === source.taskId && (item.runId ?? null) === source.runId,
  )
  if (review === undefined)
    return { ok: false, refusal: `store ${binding.rootStoreId} holds no review of ${reviewRef(source)}` }
  try {
    const scope = textOf(payload.scope)
    if (payload.scope !== undefined && scope === undefined) throw new Error('the "scope" field must be a non-empty string')
    const reviewRefs = optionalRefs(payload.reviewRefs, 'reviewRefs')
    const evidenceRefs = optionalRefs(payload.evidenceRefs, 'evidenceRefs')
    const relatedTaskIds = optionalRefs(payload.relatedTaskIds, 'relatedTaskIds')
    const known = knownReferences(snapshot)
    const invalid = [
      ...[reviewRef(source), ...(reviewRefs ?? [])].filter(ref => !known.has(ref)).map(ref => `reviewRef "${ref}"`),
      ...(evidenceRefs ?? []).filter(ref => !known.has(ref)).map(ref => `evidenceRef "${ref}"`),
      ...(relatedTaskIds ?? [])
        .filter(id => !snapshot.tasks.some(candidate => candidate.taskId === id))
        .map(id => `relatedTaskId "${id}"`),
    ]
    if (invalid.length > 0)
      return { ok: false, refusal: `the completion cites ${invalid.join(', ')} outside store ${binding.rootStoreId}` }
    const judgements = judgementsOf(payload.judgements, knownJudgementReferences(snapshot))
    const proposals = proposalsOf(payload.proposals)
    const diagnosis: Diagnosis = {
      diagnosisId: `review-agent-${binding.sessionId}`,
      taskId: source.taskId,
      observedFailure: observation,
      scope: scope ?? `task ${source.taskId}`,
      localizedCause: conclusion,
      evidenceRefs: evidenceRefs ?? review.evidenceRefs,
      reviewRefs: [...new Set([reviewRef(source), ...(reviewRefs ?? [])])],
      confidence: payload.confidence,
      proposals,
      producedBy: { kind: 'agent', sessionId: binding.sessionId },
      ...(relatedTaskIds === undefined ? {} : { relatedTaskIds }),
      ...(judgements.length === 0 ? {} : { judgements }),
    }
    return { ok: true, payload: { diagnosis } }
  } catch (error) {
    return {
      ok: false,
      refusal: `the completion's diagnosis fields are malformed: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

/** The base of one row for one assignment. */
function completionRow(
  binding: CoordinationBinding,
  result: CoordinationCompletion['result'],
  at: string,
): CoordinationCompletion {
  return {
    formatVersion: 1,
    kind: 'completion',
    graphId: binding.graphId,
    storeId: binding.rootStoreId,
    epoch: binding.epoch,
    role: binding.role,
    sessionId: binding.sessionId,
    result,
    at,
  }
}

/** The completion one accepted supervisor payload becomes, with the fields the platform derived. */
export function supervisorCompletion(
  binding: CoordinationBinding,
  payload: SupervisorCompletionPayload,
  derived: DerivedCompletionFacts,
): CoordinationCompletion {
  return completionRow(
    binding,
    {
      kind: 'completed',
      businessAction: payload.businessAction,
      reason: payload.reason,
      evidenceRefs: [...payload.evidenceRefs],
      trialCandidateRef: payload.trialCandidateRef ?? null,
      methodDecision: derived.methodDecision,
      searchNext: derived.searchNext,
      ...(derived.approval === undefined ? {} : { approval: derived.approval }),
    },
    new Date().toISOString(),
  )
}

/** The completion one accepted review becomes. */
export function reviewCompletion(
  binding: CoordinationBinding,
  diagnosisId: string,
  confidence: DiagnosisConfidence,
): CoordinationCompletion {
  return completionRow(binding, { kind: 'reviewed', diagnosisId, confidence }, new Date().toISOString())
}

/** The completion a session that ended without calling its tool leaves: recorded once, never re-asked. */
export function protocolFailure(binding: CoordinationBinding, detail: string): CoordinationCompletion {
  return completionRow(binding, { kind: 'protocol-failure', detail }, new Date().toISOString())
}

/** The completion a failed spawn or resume leaves: the session never reached model input. */
export function interrupted(binding: CoordinationBinding, detail: string): CoordinationCompletion {
  return completionRow(binding, { kind: 'interrupted', detail }, new Date().toISOString())
}

/** One on-disk row as the binding a completion is written against, for platform-written rows. */
export function bindingOfAssignment(
  assignment: { readonly graphId: string; readonly storeId: string; readonly epoch: number; readonly role: 'supervisor' | 'reviewer'; readonly subject: CoordinationBinding['subject']; readonly sessionId: string; readonly actor: string; readonly at: string },
  completed: boolean,
): CoordinationBinding {
  return {
    graphId: assignment.graphId,
    rootStoreId: assignment.storeId,
    epoch: assignment.epoch,
    role: assignment.role,
    subject: assignment.subject,
    sourceTaskId: assignment.subject.source.taskId,
    sourceRunId: assignment.subject.source.runId,
    sessionId: assignment.sessionId,
    actor: assignment.actor,
    at: assignment.at,
    completed,
  }
}
