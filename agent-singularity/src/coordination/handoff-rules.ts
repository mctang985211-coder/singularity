/** The A6 hand-off rules: what a recorded Diagnosis becomes, decided from facts alone — every diagnosis is a hand-off, and the deployment's supervision policy says what it may spend. @module @dangosys/dsh-singularity-agent/handoff-rules */

import type { WorkerGrant } from '@dangosys/dsh-singularity-agent-runtime'
import type { Diagnosis, ReviewRecord, TaskRun, TaskSnapshot } from '@dangosys/dsh-singularity-task'
import { canonicalize, sha256Hex } from '@dangosys/dsh-singularity-task'
import { reviewRef } from './identity.ts'
import { countReviewAgentRuns, reviewAgentBudget, type ReviewAgentAttempt, type ReviewAgentBudget } from './ledger.ts'
import { roundCapRefusal, sourceRoundsOf, type SupervisionRounds } from './supervision.ts'

/** Shared host preset; runtime installs the actual coordination role. */
export const COORDINATION_PRESET = 'singularity-coordinator'

/** Candidate comparison, existing human approval gates, root recovery and evidence reads. */
export const SUPERVISOR_BASELINE: readonly string[] = [
  'task_recover',
  'task_review_pack',
  'task_review_agent',
  'task_read',
  'task_status',
  'context_read',
  'capability_list',
  'task_template_list',
  'evolution_propose',
  'evolution_candidate',
  'evolution_prepare',
  'evolution_replay',
  'evolution_gate',
  'evolution_decide',
  'evolution_apply',
  'evolution_list',
  'read',
  'glob',
  'grep',
  'skill',
]

/** The capability grant one supervisor is spawned with — the same shape a reviewer's has. */
export function supervisorGrant(): WorkerGrant {
  return { capabilities: [], baseline: SUPERVISOR_BASELINE, keepPresetTools: false }
}

/** Why a hand-off was not started, by name. */
export type HandoffStopCode =
  /** The graph's root session is not live in this process, so no supervisor could be started. */
  | 'no-delegator'
  /** The store's coordination allowance (the one a reviewer consumes) is spent. */
  | 'budget-exhausted'
  /** The source has spent its recovery or improvement rounds: the hard cap ends the iteration. */
  | 'iteration-cap'
  /** One diagnosis under two different hand-offs: the identity is already promised to another content. */
  | 'handoff-conflict'

/** What a reader (the review pack) reports the A6 side from: the store's coordination attempts (both roles; the rules filter them) and the allowance in force. */
export interface HandoffFacts {
  readonly attempts: readonly ReviewAgentAttempt[]
  readonly budget: ReviewAgentBudget
}

/** The hand-off facts a pack or a reviewer prompt reads: the attempts and the allowance in force. */
export async function handoffFactsOf(storeId: string, attempts: readonly ReviewAgentAttempt[]): Promise<HandoffFacts> {
  return {
    attempts,
    budget: { used: await countReviewAgentRuns(storeId), max: reviewAgentBudget() },
  }
}

/** What one diagnosis's hand-off state is, as the ledger answers it. */
export type HandoffDecision =
  /** Nothing stands in the way: a consumption would start a supervisor. */
  | { readonly kind: 'start' }
  /** The hand-off already has its supervisor, and it is running. */
  | { readonly kind: 'started'; readonly sessionId: string; readonly at: string }
  /** A supervisor is being started for it right now (a claim of this process). */
  | { readonly kind: 'in-flight'; readonly sessionId: string }
  /** The hand-off's supervisor ended with an outcome: a recovery/improvement was issued, or the hand-off was closed. */
  | {
      readonly kind: 'concluded'
      readonly sessionId: string
      readonly status: 'recorded' | 'closed'
      readonly note?: string
      readonly at: string
    }
  /** Nothing was started, and this is why — the hand-off stays pending. */
  | { readonly kind: 'stopped'; readonly code: HandoffStopCode; readonly reason: string }

/** What the deployment would do with one diagnosis's hand-off right now, from the diagnosis, the ledger's attempts, the store's allowance and the source's round facts. Pure. */
export function handoffDecision(input: {
  readonly diagnosis: Diagnosis
  readonly attempts: readonly ReviewAgentAttempt[]
  readonly budget: ReviewAgentBudget
  /** The source's round facts, when the caller read them; absent leaves the caps to the ledger/runtime. */
  readonly rounds?: SupervisionRounds
}): HandoffDecision {
  const attempts = input.attempts.filter(
    attempt => attempt.role === 'supervisor' && attempt.diagnosisId === input.diagnosis.diagnosisId,
  )
  const started = attempts.filter(attempt => attempt.started && attempt.settlement === undefined).at(-1)
  if (started !== undefined) return { kind: 'started', sessionId: started.sessionId, at: started.at }
  const open = attempts.find(attempt => attempt.settlement === undefined)
  if (open !== undefined) return { kind: 'in-flight', sessionId: open.sessionId }
  const concluded = attempts
    .filter(attempt => attempt.settlement !== undefined && attempt.settlement.status !== 'interrupted')
    .at(-1)
  if (concluded !== undefined) {
    const settlement = concluded.settlement!
    return {
      kind: 'concluded',
      sessionId: concluded.sessionId,
      status: settlement.status === 'closed' ? 'closed' : 'recorded',
      ...(settlement.note === undefined ? {} : { note: settlement.note }),
      at: settlement.at,
    }
  }
  if (input.rounds !== undefined) {
    const cap = roundCapRefusal(input.rounds)
    if (cap !== undefined) return { kind: 'stopped', code: cap.code, reason: cap.reason }
  }
  if (input.budget.used >= input.budget.max) {
    return {
      kind: 'stopped',
      code: 'budget-exhausted',
      reason:
        `the store's coordination allowance is spent (${input.budget.used}/${input.budget.max}), and a supervisor is a run of that same ` +
        'allowance — nothing was started and the hand-off stays pending; a deployment raises the allowance, no count is reset',
    }
  }
  return { kind: 'start' }
}

/** The hand-off state as it is reported to a reader of the review pack: every recorded diagnosis is a hand-off, a conclusion without suggestions included. */
export function handoffStateLine(input: {
  readonly diagnosis: Diagnosis
  readonly attempts: readonly ReviewAgentAttempt[]
  readonly budget: ReviewAgentBudget
  readonly rounds?: SupervisionRounds
}): string {
  const decision = handoffDecision(input)
  switch (decision.kind) {
    case 'started':
      return (
        `taken up — this hand-off is delegated to supervisor session ${decision.sessionId} (started ${decision.at}); ` +
        'that coordinator owns the candidate it may open, and a person still decides the promotion'
      )
    case 'in-flight':
      return `being taken up right now by supervisor session ${decision.sessionId} — nothing new is started for it`
    case 'concluded':
      return decision.status === 'closed'
        ? `settled — supervisor session ${decision.sessionId} closed the hand-off` +
            `${decision.note === undefined ? '' : `: ${decision.note}`}; no further supervisor is started for it`
        : `taken up — this hand-off is delegated to supervisor session ${decision.sessionId}, which ended recorded` +
            `${decision.note === undefined ? '' : `: ${decision.note}`}; graph activation resumes unfinished proposal work from its durable status`
    case 'stopped':
      return `pending — ${decision.reason}`
    case 'start':
      return 'pending — no supervisor is delegated to this hand-off yet; the deployment takes it up when it consumes it'
  }
}

/** The explicit close a supervisor's reply may carry — the structured outcome that ends a hand-off without further iteration. */
export function closeOutcomeOf(reply: string | undefined): { readonly reason: string } | undefined {
  if (reply === undefined) return undefined
  const blocks = [...reply.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map(match => match[1]!)
  for (const block of blocks.reverse()) {
    try {
      const parsed: unknown = JSON.parse(block)
      if (parsed === null || typeof parsed !== 'object') continue
      if ((parsed as { outcome?: unknown }).outcome !== 'closed') continue
      const reason = (parsed as { reason?: unknown }).reason
      return {
        reason: typeof reason === 'string' && reason.trim().length > 0 ? reason : 'the supervisor closed the hand-off',
      }
    } catch {
      continue
    }
  }
  return undefined
}

/** The text of one session's last assistant message — the reply a coordination agent's outcome is read from. */
export function lastAssistantText(events: readonly { type: string; data?: unknown }[]): string | undefined {
  const event = [...events].reverse().find(item => item.type === 'assistant/message')
  if (event === undefined) return undefined
  const message = (event.data as { message?: { content?: readonly { type: string; text?: string }[] } } | undefined)
    ?.message
  const content = (message?.content ?? [])
    .filter(block => block.type === 'text')
    .map(block => block.text ?? '')
    .join('\n')
  return content.length === 0 ? undefined : content
}

/** One review record's facts as the compact read-only block a supervisor's first request carries — criteria verdicts, the derived passed/total, and the effort counters. */
export function renderSupervisorReviewFacts(review: ReviewRecord): string {
  const criteria = review.criteria ?? []
  const passed = criteria.filter(criterion => criterion.verdict === 'pass').length
  const lines = [`review ${reviewRef({ taskId: review.taskId, runId: review.runId ?? null })} [${review.outcome}]`]
  lines.push(
    criteria.length === 0
      ? 'criteria: none recorded'
      : `criteria (${passed}/${criteria.length} passed): ${criteria.map(criterion => `${criterion.criterionId} ${criterion.verdict}`).join('; ')}`,
  )
  const metrics = metricsLine(review)
  if (metrics !== undefined) lines.push(`metrics: ${metrics}`)
  if (review.logTail !== undefined) lines.push(`logTail: ${review.logTail}`)
  return lines.join('\n')
}

/** The effort counters of one review record, one clause per counter that exists — an absent field means "not observed". */
function metricsLine(review: ReviewRecord): string | undefined {
  const metrics = review.metrics
  if (metrics === undefined) return undefined
  const parts: string[] = []
  if (metrics.tokens !== undefined) {
    parts.push(
      `tokens in ${metrics.tokens.uncachedInputTokens}/out ${metrics.tokens.outputTokens}/cache ` +
        `${metrics.tokens.cacheReadTokens}+${metrics.tokens.cacheWriteTokens}`,
    )
  }
  if (metrics.toolCalls !== undefined)
    parts.push(`toolCalls ${metrics.toolCalls.calls} (${metrics.toolCalls.failures} failed)`)
  if (metrics.humanInterventions !== undefined) parts.push(`humanInterventions ${metrics.humanInterventions}`)
  if (metrics.retries !== undefined) parts.push(`retries ${metrics.retries}`)
  if (metrics.evidenceLogs !== undefined) parts.push(`evidenceLogs ${metrics.evidenceLogs}`)
  return parts.length === 0 ? undefined : parts.join(' — ')
}

/** One hand-off's content identity: what the claim promises about the diagnosis it was started for. */
export function supervisorHandoffDigest(storeId: string, diagnosis: Diagnosis): string {
  return sha256Hex(
    canonicalize({
      storeId,
      diagnosisId: diagnosis.diagnosisId,
      taskId: diagnosis.taskId,
      proposals: diagnosis.proposals.map(proposal => ({
        targetType: proposal.targetType,
        targetId: proposal.targetId,
        rationale: proposal.rationale,
      })),
    }),
  )
}

/** One hand-off's source task and the run its diagnosis is about, or `null` for the no-run case. */
function diagnosisRunRef(diagnosis: Diagnosis): string | null {
  for (const ref of diagnosis.reviewRefs) {
    const separator = ref.lastIndexOf('#')
    if (separator < 0) continue
    if (ref.slice(0, separator) !== diagnosis.taskId) continue
    const runId = ref.slice(separator + 1)
    return runId === 'no-run' ? null : runId
  }
  return null
}

/** The hand-off's source: the task and run the Diagnosis is about — the delegation's own fields. */
export function handoffSourceOf(diagnosis: Diagnosis): { readonly taskId: string; readonly runId: string | null } {
  return { taskId: diagnosis.taskId, runId: diagnosisRunRef(diagnosis) }
}

/** The actual delegating parent of a child diagnosis; roots have no parent. */
export function responsibleParentRun(snapshot: TaskSnapshot, diagnosis: Diagnosis): TaskRun | undefined {
  const task = snapshot.tasks.find(item => item.taskId === diagnosis.taskId)
  if (task?.parentTaskId === undefined) return undefined
  const source = handoffSourceOf(diagnosis)
  const sourceRun = snapshot.runs.find(run => run.runId === source.runId)
  const parent =
    source.runId === null
      ? snapshot.runs.find(
          run =>
            run.taskId === task.parentTaskId && run.batches?.some(batch => batch.memberTaskIds.includes(task.taskId)),
        )
      : snapshot.runs.find(run => run.runId === sourceRun?.parentRunId)
  return parent?.taskId === task.parentTaskId ? parent : undefined
}

/** Ordinary child diagnoses are handled by their parent without another coordination agent. */
export function needsSupervisor(
  snapshot: TaskSnapshot,
  diagnosis: Diagnosis,
  attempts: readonly ReviewAgentAttempt[] = [],
): boolean {
  const reviewer = attempts.find(attempt => attempt.sessionId === diagnosis.producedBy?.sessionId)
  // A focused reviewer reports to its existing supervisor, including after restart.
  if (
    reviewer !== undefined &&
    attempts.some(attempt => attempt.role === 'supervisor' && attempt.sessionId === reviewer.actor)
  )
    return false
  if (sourceReviewOf(snapshot, diagnosis)?.outcome === 'verified' && diagnosis.proposals.length === 0) return false
  const task = snapshot.tasks.find(item => item.taskId === diagnosis.taskId)
  return task?.parentTaskId === undefined || diagnosis.proposals.length > 0
}

/** The ref a reader uses for one source (`<taskId>#<runId>`, or `<taskId>#no-run`). */
export const handoffSourceRef = reviewRef

/** The prior round's review record, as the store holds it for one diagnosis's source. */
function sourceReviewOf(snapshot: TaskSnapshot, diagnosis: Diagnosis): ReviewRecord | undefined {
  const source = handoffSourceOf(diagnosis)
  return snapshot.reviews.find(item => item.taskId === source.taskId && (item.runId ?? null) === source.runId)
}

/** The source's round facts as the store records them, for the cap checks in this module and the ledger. */
export function roundsForDiagnosis(snapshot: TaskSnapshot, diagnosis: Diagnosis): SupervisionRounds {
  return sourceRoundsOf(snapshot, diagnosis.taskId, sourceReviewOf(snapshot, diagnosis)?.outcome ?? 'unknown')
}

/** The prior round's review facts as the read-only text block a supervisor's first request carries, or nothing when the store holds no review for the source. */
export function reviewFactsFor(snapshot: TaskSnapshot, diagnosis: Diagnosis): string | undefined {
  const review = sourceReviewOf(snapshot, diagnosis)
  return review === undefined ? undefined : renderSupervisorReviewFacts(review)
}

/** Current durable facts accompany the stable supervisor policy. */
export function supervisorPrompt(input: {
  readonly diagnosis: Diagnosis
  readonly sourceOutcome: string
  readonly sourceRef: string
  readonly reviewFacts?: string
  readonly parentRun?: TaskRun
  readonly childSource?: boolean
  readonly proposals?: readonly { proposalId: string; status: string; decision?: string }[]
}): string {
  const { diagnosis } = input
  return [
    `The hand-off is diagnosis ${diagnosis.diagnosisId} about task ${diagnosis.taskId} (source ${input.sourceRef}, whose review settled ${input.sourceOutcome}).`,
    `Its recorded observation: ${diagnosis.observedFailure}`,
    `Its recorded conclusion: ${diagnosis.localizedCause}`,
    `Diagnosis scope: ${diagnosis.scope}; related tasks: ${diagnosis.relatedTaskIds?.join(', ') || 'none'}.`,
    `Review sources: ${diagnosis.reviewRefs.join(', ')}; evidence: ${diagnosis.evidenceRefs.join(', ') || 'none'}.`,
    ...diagnosis.proposals.map(
      proposal => `Suggested ${proposal.targetType} ${proposal.targetId}: ${proposal.rationale}`,
    ),
    input.parentRun === undefined
      ? input.childSource
        ? 'The source is a child; its responsible parent run could not be read. Do not open a root recovery for it.'
        : 'The source is the root goal.'
      : `Responsible parent: task ${input.parentRun.taskId}, run ${input.parentRun.runId}, session ${input.parentRun.sessionId} [${input.parentRun.status}]. The parent replans this child; task_recover does not accept child diagnoses.`,
    '--- prior round review facts (read-only) ---',
    input.reviewFacts ?? 'No review record could be read; read task_review_pack for the exact source.',
    '--- end of prior round review facts ---',
    'Existing proposals for this diagnosis:',
    ...(input.proposals?.length
      ? input.proposals.map(
          proposal =>
            `${proposal.proposalId} [${proposal.status}]${proposal.decision === undefined ? '' : ` ${proposal.decision}`}`,
        )
      : ['none']),
    '',
    'Read task_review_pack, task_status scope:"graph", related diagnoses and original evidence through context_read. Start with the whole Task DAG, then inspect the relevant contracts, exact Run reviews, dependency edges and frozen Skill bindings. Do not create a duplicate proposal.',
    'Read relevant reusable contracts through task_template_list, then its exact templateRef. Executable Evolution targetType names are task_definition (a TaskTemplate; targetId is the template id), skill and capability. Other target types remain suggestions.',
    'When a causal question needs deeper independent investigation, call task_review_agent for the relevant exact taskId/runId with a concrete reason and a stable requestKey. Its read-only diagnosis returns to you; it does not open another supervisor. Reuse recorded diagnoses before asking again. Reconcile supporting and conflicting evidence, then make one evidence-based decision; a discussion or vote is not an experiment.',
    `For an established shared gap, cite diagnosis:${diagnosis.diagnosisId} in evolution_propose.sourceRefs. Use only supported candidate targets and only tools actually granted: evolution_candidate → evolution_prepare → evolution_replay → evolution_gate. Missing artifacts alone do not establish a shared gap.`,
    ...(input.sourceOutcome === 'verified'
      ? [
          `For this successful source, evolution_replay must declare objective: "tool-call-reduction", include task ${diagnosis.taskId} in taskIds, and name independent verified holdoutTaskIds. The experiment requires unchanged acceptance and lower complete Run subtree tool-call counts; unknown counters prove no improvement.`,
        ]
      : []),
    'A gated proposal continues with evolution_decide to request the human decision. A PROMOTE-decided proposal continues with evolution_apply to request approval for its exact production writes. If approval is denied or unavailable, report proposalId and its current status and stop. A rejected or research-only decision opens no recovery for that change.',
    input.childSource
      ? 'After a child shared change is applied, finish with the proposal id and evidence. The runtime notifies the responsible parent to read its state and replan. Do not call task_recover for the child.'
      : `Apply any necessary shared changes first. Then, if another round is justified, call task_recover with { sourceDiagnosisId: "${diagnosis.diagnosisId}", requestKey: "recovery:${diagnosis.diagnosisId}"${input.sourceOutcome === 'verified' ? ', mode: "improve"' : ''} }. The original acceptance judges it; repeating the key returns the same attempt. A cap refusal ends iteration.`,
    'If no justified action remains, explain why and end with one fenced json block {"outcome":"closed","reason":"..."}. Closing changes no task state. Unsupported candidate targets require a concrete explanation rather than invented tool support.',
  ].join('\n')
}
