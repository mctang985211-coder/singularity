/** The A6 hand-off rules: what a Diagnosis with suggestions is allowed to become, decided from facts alone. @module @dangosys/dsh-singularity-agent/handoff-rules */

import type { Context } from '@deepseek-ai/cordis'
import type { WorkerGrant } from '@dangosys/dsh-singularity-agent-runtime'
import type { Diagnosis } from '@dangosys/dsh-singularity-task'
import { canonicalize, sha256Hex } from '@dangosys/dsh-singularity-task'
import { optionalService } from '@dangosys/dsh-singularity-task-runtime'
import { reviewRef } from './identity.ts'
import { countReviewAgentRuns, reviewAgentBudget, type ReviewAgentAttempt, type ReviewAgentBudget } from './ledger.ts'

/** The preset both coordination roles mount (A5's reviewer and A6's supervisor): */
export const COORDINATION_PRESET = 'singularity-reviewer'

/** The supervisor's whole tool surface. Read-only plus the two entries the hand-off is for: the evolution candidate chain (`propose` → `candidate` → `prepare` → `replay` → `gate` → `list`) and `task_recover`. Absent by */
export const SUPERVISOR_BASELINE: readonly string[] = [
  'task_recover',
  'task_review_pack',
  'task_read',
  'task_status',
  'context_read',
  'capability_list',
  'evolution_propose',
  'evolution_candidate',
  'evolution_prepare',
  'evolution_replay',
  'evolution_gate',
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

/** The target types whose suggestion this build can take up: a same-name skill update, or one whole capability row. */
export const SUPPORTED_HANDOFF_TARGETS: readonly string[] = ['skill', 'capability']

/** Why a hand-off was not opened, by name. */
export type HandoffStopCode =
  /** The diagnosis carries no suggestions: a conclusion, not a hand-off. */
  | 'no-suggestions'
  /** This deployment registered no evolution chain, so a coordinator would have no candidate surface. */
  | 'evolution-off'
  /** A suggestion names a target type this build does not record at all. */
  | 'unsupported-target'
  /** A suggestion would need new tooling, a new verifier, a permission or a preset — all refused by name in this build. */
  | 'requires-new-authority'
  /** The store's coordination allowance (the one a reviewer consumes) is spent. */
  | 'budget-exhausted'
  /** One diagnosis under two different hand-offs: the identity is already promised to another content. */
  | 'handoff-conflict'

/** Whether this deployment registered the evolution chain — the switch the whole consumption turns into one question (agent-singularity's own `ctx.singularityEvolution`). Read softly and read as **off** when the service is */
export function evolutionEnabled(ctx: Context): boolean {
  return optionalService<{ readonly enabled?: boolean }>(ctx, 'singularityEvolution')?.enabled === true
}

/** What a reader (the review pack) reports the A6 side from: whether this deployment registered the evolution chain, the store's coordination attempts (both roles; the rules filter them), and the allowance in force. */
export interface HandoffFacts {
  /** `ctx.singularityEvolution.enabled`: whether the nine `evolution_*` tools exist on this surface. */
  readonly enabled: boolean
  readonly attempts: readonly ReviewAgentAttempt[]
  readonly budget: ReviewAgentBudget
}

/** The hand-off facts a pack or a reviewer prompt reads: the deployment's switch, the attempts and the allowance in force. */
export async function handoffFactsOf(ctx: Context, storeId: string, attempts: readonly ReviewAgentAttempt[]): Promise<HandoffFacts> {
  return {
    enabled: evolutionEnabled(ctx),
    attempts,
    budget: { used: await countReviewAgentRuns(storeId), max: reviewAgentBudget() },
  }
}

/** What one diagnosis's hand-off state is, as the ledger and the deployment's own switch answer it. */
export type HandoffDecision =
  /** Nothing stands in the way: a consumption would start a supervisor. */
  | { readonly kind: 'start' }
  /** The hand-off already has its supervisor. */
  | { readonly kind: 'started'; readonly sessionId: string; readonly at: string }
  /** A supervisor is being started for it right now (a claim of this process). */
  | { readonly kind: 'in-flight'; readonly sessionId: string }
  /** Nothing was opened, and this is why — the hand-off stays pending. */
  | { readonly kind: 'stopped'; readonly code: HandoffStopCode; readonly reason: string }

/** The recorded mutation surfaces this build's Evolution ledger accepts, as `evolution_propose` validates them. */
export const PROPOSAL_TARGET_TYPES: readonly string[] = [
  'skill', 'tool', 'capability', 'task_definition', 'decomposition_policy',
  'agent_preset', 'workflow_policy', 'verifier', 'runtime_policy',
]

/** The target-type rule one diagnosis's suggestions have to pass before a coordinator is started, in the deployment's own words, or nothing when they do. */
export function handoffTargetRefusal(diagnosis: Diagnosis): { readonly code: HandoffStopCode; readonly reason: string } | undefined {
  for (const proposal of diagnosis.proposals) {
    const targetType = proposal.targetType
    if (SUPPORTED_HANDOFF_TARGETS.includes(targetType)) continue
    if (!PROPOSAL_TARGET_TYPES.includes(targetType)) {
      return {
        code: 'unsupported-target',
        reason:
          `the suggestion's target type ${JSON.stringify(targetType)} is not an execution target this build records ` +
          `(recorded: ${PROPOSAL_TARGET_TYPES.join(', ')}), so no coordinator was started for it and the Diagnosis keeps its ` +
          'suggestion — an unknown target is refused by name, never guessed into a candidate',
      }
    }
    return {
      code: 'requires-new-authority',
      reason:
        `the suggestion targets "${targetType}", and this build executes exactly two candidate surfaces — a same-name update of an ` +
        'existing skill object and one whole capability row with an optional new execution skill; a new tool, a verifier ' +
        'implementation, a permission, a preset or a runtime policy would need an authorization this harness refuses by name, ' +
        'so no coordinator was started and the Diagnosis keeps its suggestion',
    }
  }
  return undefined
}

/** The refusals decided before anything else is read — no suggestions at all, the chain being off, and a suggestion this build cannot execute — as the one `undefined | {code, reason}` both {@link. */
export function handoffPreflight(input: {
  readonly enabled: boolean
  readonly diagnosis: Diagnosis
}): { readonly code: HandoffStopCode; readonly reason: string } | undefined {
  if (input.diagnosis.proposals.length === 0) {
    return { code: 'no-suggestions', reason: 'the conclusion carries no suggestion, so there is no hand-off to take up' }
  }
  if (!input.enabled) {
    return {
      code: 'evolution-off',
      reason:
        'the evolution chain is off in this deployment, so no coordinator exists to open a candidate for it — the Diagnosis stays a ' +
        'recorded hand-off, readable here and in the review pack, and turning the chain on is what takes it up',
    }
  }
  return handoffTargetRefusal(input.diagnosis)
}

/** What the deployment would do with one diagnosis's hand-off right now, from the switch, the diagnosis, the ledger's attempts and the store's allowance. Pure. */
export function handoffDecision(input: {
  readonly enabled: boolean
  readonly diagnosis: Diagnosis
  readonly attempts: readonly ReviewAgentAttempt[]
  readonly budget: ReviewAgentBudget
}): HandoffDecision {
  const attempts = input.attempts.filter(attempt => attempt.role === 'supervisor' && attempt.diagnosisId === input.diagnosis.diagnosisId)
  const started = attempts.filter(attempt => attempt.started && attempt.settlement === undefined).at(-1)
  if (started !== undefined) return { kind: 'started', sessionId: started.sessionId, at: started.at }
  const preflight = handoffPreflight(input)
  if (preflight !== undefined) return { kind: 'stopped', code: preflight.code, reason: preflight.reason }
  const open = attempts.find(attempt => attempt.settlement === undefined)
  if (open !== undefined) return { kind: 'in-flight', sessionId: open.sessionId }
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

/** The hand-off state as it is reported to a reader of the review pack, or nothing when the diagnosis carries no suggestions (a normal completion stays a conclusion and gets no mark). */
export function handoffStateLine(input: {
  readonly enabled: boolean
  readonly diagnosis: Diagnosis
  readonly attempts: readonly ReviewAgentAttempt[]
  readonly budget: ReviewAgentBudget
}): string | undefined {
  if (input.diagnosis.proposals.length === 0) return undefined
  const decision = handoffDecision(input)
  switch (decision.kind) {
    case 'started':
      return `taken up — this hand-off is delegated to supervisor session ${decision.sessionId} (started ${decision.at}); ` +
        'that coordinator owns the candidate it may open, and a person still decides the promotion'
    case 'in-flight':
      return `being taken up right now by supervisor session ${decision.sessionId} — nothing new is started for it`
    case 'stopped':
      return `pending — ${decision.reason}`
    case 'start':
      return 'pending — no supervisor is delegated to this hand-off yet; the deployment takes it up when it consumes it'
  }
}

/** One hand-off's content identity: what the claim promises about the diagnosis it was started for. */
export function supervisorHandoffDigest(storeId: string, diagnosis: Diagnosis): string {
  return sha256Hex(canonicalize({
    storeId,
    diagnosisId: diagnosis.diagnosisId,
    taskId: diagnosis.taskId,
    proposals: diagnosis.proposals.map(proposal => ({
      targetType: proposal.targetType,
      targetId: proposal.targetId,
      rationale: proposal.rationale,
    })),
  }))
}

/** The run one diagnosis is about, as its own `reviewRefs` name it (`<taskId>#<runId>`, or `<taskId>#no-run` for the failure that had none). A diagnosis that names no review of its own task leaves the run `null`: which run */
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

/** The ref a reader uses for one source (`<taskId>#<runId>`, or `<taskId>#no-run`). */
export const handoffSourceRef = reviewRef

/** The supervisor's first request: which hand-off it is taking up, what the source really is, and what it is expected to do with it. */
export function supervisorPrompt(input: {
  readonly diagnosis: Diagnosis
  readonly sourceOutcome: string
  readonly sourceRef: string
}): string {
  const { diagnosis } = input
  return [
    'You are the Singularity supervisor: the coordination agent a recorded Diagnosis was handed to. You do not run the goal, and you do not decide promotions — a person does.',
    `The hand-off is diagnosis ${diagnosis.diagnosisId} about task ${diagnosis.taskId} (source ${input.sourceRef}, whose review settled ${input.sourceOutcome}).`,
    `Its recorded observation: ${diagnosis.observedFailure}`,
    `Its recorded conclusion: ${diagnosis.localizedCause}`,
    'Its recorded suggestions:',
    ...diagnosis.proposals.map(proposal => `- ${proposal.targetType} ${proposal.targetId}: ${proposal.rationale}`),
    '',
    'Your job, in this order:',
    '1. Read the facts yourself: task_review_pack for the exact source, task_read/task_status for the task and its siblings, context_read for the sessions and evidence the pack cites.',
    '2. Create a candidate only if the original evidence establishes a capability or skill gap: evolution_propose (when no proposal names it yet), evolution_candidate for ONE whole capability row plus an optional new execution skill or a same-name update of an existing skill, then evolution_prepare, evolution_replay, and evolution_gate. A missing artifact alone does not establish such a gap. A person decides and applies; you never call evolution_decide, evolution_apply or evolution_rollback.',
    `3. Only you, as the delegated supervisor, may call task_recover for a failed root goal; a failed child needs a new batch from its business parent. Associated capability changes must already be applied. A pure artifact gap needs no candidate when the source's required capability rows already resolve. Call task_recover with { sourceDiagnosisId: "${diagnosis.diagnosisId}", requestKey: "<a key of yours>" }; the new attempt retains the original acceptance criteria, and repeating the key returns the same attempt. If a precondition is unmet, name it and stop; do not invent a capability proposal to unlock a retry.`,
    '4. Not every suggestion is executable: a successful source is not recoverable, and a target type this build has no candidate for stays a recorded suggestion. Say what stopped you in your own words — nothing you write changes production, and no candidate executes anything by itself.',
    '',
    'You have no shell, no file write and no spawn, and no tool outside the list you were granted.',
  ].join('\n')
}
