/**
 * One review attempt: claim the work item, spawn the reviewer, wait for its
 * completion record and read the diagnosis it recorded back out of the store.
 * The reviewer's answer is a structured record it writes through
 * `reviewer_complete`; nothing here parses prose.
 *
 * @module @dangosys/dsh-singularity-agent/coordination/review-run
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {
  Diagnosis,
  DiagnosisProposal,
  ReviewJudgement,
  ReviewRecord,
  TaskSnapshot,
} from '@dangosys/dsh-singularity-task'
import { planAssignment, subjectDigest, type AssignmentRefusalCode, type AssignmentRequest } from './assignment.ts'
import { protocolFailure } from './completion.ts'
import { onCoordinationCompletion, readCoordinationBinding, readCoordinationRows, recordCompletion, type CoordinatedWork, type CoordinationCompletion } from './store.ts'
import { reviewRef, type ReviewParentAgent } from './identity.ts'
import { readSessionFactsOf } from './session-facts.ts'
import { spawnAssignment } from './spawn-assignment.ts'
import { REVIEWER_PRESET, reviewerGrant } from './roles.ts'
import { rootTaskOf, terminalRootRuns } from './rounds.ts'
import { buildReviewPack } from '../tools/task-review-pack.ts'

export { REVIEWER_BASELINE, REVIEWER_PRESET, reviewerGrant } from './roles.ts'
export { renderJudgements } from './render.ts'

/** The source one attempt reviews, as a ref a reader reads back (`t1#r1`, `t2#no-run`). */
export function sourceRef(source: { readonly taskId: string; readonly runId: string | null }): string {
  return reviewRef(source)
}

/** The diagnosis one attempt recorded, as the store holds it (the id is the attempt's session). */
export function recordedDiagnosis(snapshot: TaskSnapshot, sessionId: string): Diagnosis | undefined {
  return snapshot.diagnoses.find(diagnosis => diagnosis.diagnosisId === `review-agent-${sessionId}`)
}

/** Everything one review attempt needs, resolved by the caller that means the source. */
export interface ReviewAttemptInput {
  readonly ctx: Context
  /** The root task store the attempt and its allowance belong to. */
  readonly storeId: string
  /** The exact source: the task and the run under review, or the no-run case. */
  readonly source: { readonly taskId: string; readonly runId: string | null }
  /** The review record of that source, as the store holds it. */
  readonly review: ReviewRecord
  /** The reviewer's parent — the live agent whose spawn publishes the review node. */
  readonly parent: ReviewParentAgent
  /** The session that asked for the attempt (the caller). */
  readonly actor: string
  readonly requestKey: string | null
  readonly reason: string | null
  readonly signal?: AbortSignal
}

/** What one attempt ended as. */
export type ReviewAttemptOutcome =
  /** Refused by name before any assignment or spawn. */
  | {
      readonly kind: 'refused'
      readonly code: AssignmentRefusalCode
      readonly detail: string
      readonly budget: { readonly used: number; readonly max: number } | undefined
      readonly work: CoordinatedWork | undefined
    }
  /** The request is this source's work item already: return it; nothing spawned, nothing written. */
  | { readonly kind: 'reuse'; readonly work: CoordinatedWork }
  /** Another attempt of the source is not settled here: the request was not accepted. */
  | { readonly kind: 'in-flight'; readonly work: CoordinatedWork }
  /** The spawn failed before any model input: the work item is recorded interrupted. */
  | { readonly kind: 'spawn-failed'; readonly failure: string; readonly sessionId: string }
  /** The reviewer ended without writing a completion: the attempt is a protocol failure. */
  | { readonly kind: 'no-completion'; readonly failure: string; readonly sessionId: string }
  /** The reviewer recorded its diagnosis: the work item is settled and the store holds the record. */
  | {
      readonly kind: 'recorded'
      readonly sessionId: string
      readonly diagnosisId: string
      readonly confidence: 'high' | 'medium' | 'low'
      readonly observation: string
      readonly conclusion: string
      readonly scope: string
      readonly reviewRefs: readonly string[]
      readonly evidenceRefs: readonly string[]
      readonly relatedTaskIds: readonly string[]
      readonly judgements: readonly ReviewJudgement[]
      readonly proposals: readonly DiagnosisProposal[]
    }

/** How long the completion record may lag behind the turn it concluded before the call stops waiting for it. */
const COMPLETION_GRACE_MS = 2_000

/** How often that grace re-reads the store. */
const COMPLETION_POLL_MS = 50

/** Run one review attempt for one source: plan, claim, spawn, then read the record back. */
export async function runReviewAgentAttempt(input: ReviewAttemptInput): Promise<ReviewAttemptOutcome> {
  const { ctx, storeId, source, review, parent, actor } = input
  const sessionId = SessionId(randomUUID())
  const graph = await ctx.graphs.graphForSession(parent.id)
  const snapshot: TaskSnapshot = await ctx.task.snapshotIn(storeId)
  const root = rootTaskOf(snapshot)
  const businessRound = root === undefined ? null : terminalRootRuns(snapshot, root.taskId).length
  const key = {
    graphId: graph.id,
    epoch: graph.rsi?.epoch ?? 1,
    role: 'reviewer' as const,
    subject: {
      kind: 'review' as const,
      businessRound,
      source,
      requestKey: input.requestKey,
    },
  }
  const request: AssignmentRequest = {
    key,
    storeId,
    sessionId,
    actor,
    digest: subjectDigest(key),
    focus: input.reason,
  }
  const rows = (await readCoordinationRows()) ?? []
  const sessions = await readSessionFactsOf(ctx, rows.filter(row => row.graphId === graph.id).map(row => row.sessionId))
  const budget = { used: rows.filter(row => row.kind === 'assignment' && row.storeId === storeId).length, max: Number.MAX_SAFE_INTEGER }
  const plan = planAssignment({ request, rows, sessions, budget })
  if (plan.kind === 'refused')
    return { kind: 'refused', code: plan.code, detail: plan.detail, budget: undefined, work: plan.work }
  if (plan.kind === 'reuse') return { kind: 'reuse', work: plan.work }
  if (plan.kind === 'in-flight' || plan.kind === 'resume') return { kind: 'in-flight', work: plan.work }
  const spawned = await spawnAssignment({
    ctx,
    request,
    parent,
    name: `review ${source.taskId}`,
    preset: REVIEWER_PRESET,
    grant: reviewerGrant(),
    role: 'reviewer',
    signal: input.signal,
    prompt: () => reviewerPrompt(input, snapshot),
  })
  if (spawned.kind === 'spawn-failed')
    return { kind: 'spawn-failed', failure: spawned.failure, sessionId: String(sessionId) }
  const completion = await waitForCompletion(input, String(sessionId), spawned.handle)
  const current: TaskSnapshot = await ctx.task.snapshotIn(storeId)
  const diagnosis = recordedDiagnosis(current, String(sessionId))
  if (completion?.result.kind !== 'reviewed' || diagnosis === undefined)
    return {
      kind: 'no-completion',
      failure:
        completion === undefined
          ? 'the reviewer session ended its turn without calling reviewer_complete'
          : `the reviewer reported ${completion.result.kind} rather than a completed review`,
      sessionId: String(sessionId),
    }
  return {
    kind: 'recorded',
    sessionId: String(sessionId),
    diagnosisId: diagnosis.diagnosisId,
    confidence: diagnosis.confidence,
    observation: diagnosis.observedFailure,
    conclusion: diagnosis.localizedCause,
    scope: diagnosis.scope,
    reviewRefs: diagnosis.reviewRefs,
    evidenceRefs: diagnosis.evidenceRefs,
    relatedTaskIds: diagnosis.relatedTaskIds ?? [],
    judgements: diagnosis.judgements ?? [],
    proposals: diagnosis.proposals,
  }
}

/**
 * Wait for the reviewer's own turn to end, then read the completion it wrote.
 * The wait is on the agent this call spawned — not on a session somewhere else —
 * so a reviewer that never calls its tool is a protocol failure rather than a
 * call that hangs, and an interrupted turn stays DSH's to repair.
 */
async function waitForCompletion(
  input: ReviewAttemptInput,
  sessionId: string,
  handle: { readonly agent: { whenIdle(): Promise<void> } },
): Promise<CoordinationCompletion | undefined> {
  const idle = handle.agent.whenIdle().catch(() => undefined)
  await (input.signal === undefined
    ? idle
    : Promise.race([idle, new Promise<void>(resolve => input.signal!.addEventListener('abort', () => resolve(), { once: true }))]))
  const deadline = Date.now() + COMPLETION_GRACE_MS
  let found: CoordinationCompletion | undefined
  for (;;) {
    const rows = (await readCoordinationRows().catch(() => [])) ?? []
    found = rows.find(row => row.kind === 'completion' && row.sessionId === sessionId) as CoordinationCompletion | undefined
    if (found !== undefined || Date.now() >= deadline) break
    await new Promise(resolve => setTimeout(resolve, COMPLETION_POLL_MS))
  }
  if (found === undefined && input.signal?.aborted !== true) await abandon(sessionId).catch(() => undefined)
  return found
}

/** Record a work item whose reviewer ended without a completion as a protocol failure. */
async function abandon(sessionId: string): Promise<void> {
  const binding = await readCoordinationBinding(sessionId)
  if (binding === undefined || binding.completed) return
  await recordCompletion(protocolFailure(binding, 'the reviewer session ended without calling reviewer_complete'))
}

/** The one request a reviewer reads: the facts of the source, and how to end. */
function reviewerPrompt(input: ReviewAttemptInput, snapshot: TaskSnapshot): string {
  const { source, review } = input
  const pack = buildReviewPack({ snapshot, source, work: [] })
  return [
    'You are a Singularity review agent. Explain the review source below: what happened, why, and what — if anything — should change.',
    'Read what you are authorized to read: the pack below, and beyond it whatever settles the question — task_read, task_status and ' +
      'context_read reach the sibling tasks, their sessions and their evidence; task_template_list reads the delegated task\'s template catalog and exact templateRef contracts. Cite what you rest on.',
    'Provide read-only analysis grounded in the recorded evidence.',
    'Start with this exact source, then inspect the business DAG and read original evidence where it distinguishes plausible causes. Explain how exploration decisions, result boundaries, upstream contracts, dependencies, shared providers or decomposition could produce the observed result. Establish a shared cause with evidence linking the implicated results.',
    ...(review.outcome === 'verified'
      ? [
          'The run passed its review; inspect the delivered result, acceptance coverage and exploration choices as well as avoidable tool calls, repeated reads, retries and decomposition costs. Compare candidates under the original acceptance with real two-sided replay. Mark fresh transfer unknown when it has not been measured.',
        ]
      : []),
    'End this session by calling reviewer_complete with observation (required: what was actually observed), conclusion (required: the cause, citing the original outcome evidence), confidence (required: high | medium | low), and only when you made them scope, reviewRefs, evidenceRefs, relatedTaskIds, judgements and proposals.',
    '- reviewRefs must be exact taskId#runId (or taskId#no-run) refs from this store; top-level evidenceRefs must be evidence bundle ids read through context_read kind:"evidence"; relatedTaskIds must be actual task ids in this graph.',
    "- judgements (optional): [{dimension, verdict, evidenceRefs, rationale}] where dimension is one of the judged dimensions and each judgement cites at least one recorded ref and a rationale.",
    '- proposals (optional): [{targetType, targetId, rationale}] — suggestions for the supervisor; nothing here executes them.',
    'Calling reviewer_complete closes this session’s write access; reads and findings stay available. A session that ends its turn without calling it is a protocol failure and no diagnosis is invented from its silence.',
    '',
    '--- source under review ---',
    `review ${sourceRef(source)} [${review.outcome}]${input.reason === null ? '' : ` — focus: ${input.reason}`}`,
    '',
    '--- review pack ---',
    pack,
  ].join('\n')
}
