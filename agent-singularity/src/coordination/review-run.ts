/** One review attempt, from its claim to its settled fact — the entry both triggers share (A5). @module @dangosys/dsh-singularity-agent/review-agent-run */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { WorkerGrant } from '@dangosys/dsh-singularity-agent-runtime'
import type {
  Diagnosis,
  DiagnosisConfidence,
  DiagnosisProposal,
  JudgementVerdict,
  ReviewJudgement,
  ReviewRecord,
  TaskSnapshot,
} from '@dangosys/dsh-singularity-task'
import { JUDGED_DIMENSIONS, JUDGEMENT_VERDICTS } from '@dangosys/dsh-singularity-task'
import { logOf } from '../log.ts'
import { message } from '../shared.ts'
import { consumeHandoffDiagnosis } from './evolution-handoff.ts'
import { handoffFactsOf, lastAssistantText } from './handoff-rules.ts'
import { reviewRef, type ReviewParentAgent } from './identity.ts'
import {
  admitReviewAgent,
  readReviewAgentAttempts,
  settleReviewAgentAttempt,
  type ReviewAgentAttempt,
  type ReviewAgentAttemptRequest,
  type ReviewAgentPlan,
  type ReviewAgentSettlementStatus,
  type ReviewAgentSource,
} from './ledger.ts'
import { spawnUnderClaim } from './spawn-under-claim.ts'
import { buildReviewPack } from '../tools/task-review-pack.ts'

/** Shared coordinator composition; runtime installs the reviewer policy. */
export const REVIEWER_PRESET = 'singularity-coordinator'

/** The review agent's whole tool surface. Read-only by construction: */
export const REVIEWER_BASELINE: readonly string[] = [
  'task_review_pack',
  'task_read',
  'task_status',
  'context_read',
  'capability_list',
  'read',
  'glob',
  'grep',
  'skill',
]

/** The capability grant one review agent is spawned with. */
export function reviewerGrant(): WorkerGrant {
  return { capabilities: [], baseline: REVIEWER_BASELINE, keepPresetTools: false }
}

/** The source one attempt reviews, as a ref a reader reads back (`t1#r1`, `t2#no-run`). */
export function sourceRef(source: ReviewAgentSource): string {
  return reviewRef({ taskId: source.taskId, runId: source.runId })
}

/** One raw judgement object as the reviewer wrote it, before validation. */
interface RawJudgement {
  dimension?: unknown
  verdict?: unknown
  evidenceRefs?: unknown
  rationale?: unknown
}

/** One raw proposal object as the reviewer wrote it, before validation. */
interface RawProposal {
  targetType?: unknown
  targetId?: unknown
  rationale?: unknown
}

/** The reviewer's answer: the two prose slots a diagnosis is made of, and what it chose to add. */
interface RawDiagnosisReply {
  observation: string
  conclusion: string
  confidence: DiagnosisConfidence
  judgements: ReviewJudgement[]
  proposals: DiagnosisProposal[]
}

/** The parsed reply object out of the reviewer's answer: the last fenced block wins, then the last balanced object. A reply with neither parses as nothing. */
function parseReviewerObject(reply: string | undefined): Record<string, unknown> | undefined {
  if (reply === undefined) return undefined
  const fenced = [...reply.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map(match => match[1])
  const candidate = fenced[fenced.length - 1]
  if (candidate === undefined) return undefined
  try {
    const parsed: unknown = JSON.parse(candidate)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

/** A non-empty string out of the reply, or nothing. */
function textOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

/** Validate the judgements the reviewer chose to make. Each one has to name a judged dimension and a verdict from the fixed vocabulary, cite at least one non-empty ref and carry a rationale — this is the. */
function judgementsOf(value: unknown): ReviewJudgement[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error('the "judgements" field is not an array')
  return value.map((item: unknown, index: number) => {
    const entry = (item ?? {}) as RawJudgement
    const dimension = entry.dimension
    if (!JUDGED_DIMENSIONS.includes(dimension as never)) {
      throw new Error(`judgement ${index} names dimension "${String(dimension)}", which is not one of ${JUDGED_DIMENSIONS.join(', ')}`)
    }
    const verdict = entry.verdict
    if (!JUDGEMENT_VERDICTS.includes(verdict as JudgementVerdict)) {
      throw new Error(`judgement ${index} (${String(dimension)}) has verdict "${String(verdict)}", which is not adequate/inadequate/unknown`)
    }
    const refs = Array.isArray(entry.evidenceRefs)
      ? entry.evidenceRefs.filter((ref): ref is string => typeof ref === 'string' && ref.length > 0)
      : []
    if (refs.length === 0) {
      throw new Error(`judgement ${index} (${String(dimension)}) cites no evidence — a conclusion that rests on nothing is not recorded`)
    }
    const rationale = textOf(entry.rationale)
    if (rationale === undefined) throw new Error(`judgement ${index} (${String(dimension)}) carries no rationale`)
    return { dimension: dimension as ReviewJudgement['dimension'], verdict: verdict as JudgementVerdict, evidenceRefs: refs, rationale }
  })
}

/** Validate the proposals the reviewer chose to make: a target name, an id and a reason, each grounded in what it wrote. */
function proposalsOf(value: unknown): DiagnosisProposal[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error('the "proposals" field is not an array')
  return value.map((item: unknown, index: number) => {
    const entry = (item ?? {}) as RawProposal
    const targetType = textOf(entry.targetType)
    const targetId = textOf(entry.targetId)
    const rationale = textOf(entry.rationale)
    if (targetType === undefined || targetId === undefined || rationale === undefined) {
      throw new Error(`proposal ${index} needs a non-empty targetType, targetId and rationale`)
    }
    return { targetType, targetId, rationale }
  })
}

/** The diagnosis the reviewer's reply carries, or a named reason it carries none. What is required is what a Diagnosis is: the **observation** (the persisted `observedFailure` slot, read as the postmortem observation — a */
export function parseReviewerDiagnosis(
  reply: string | undefined,
): { readonly ok: true; readonly diagnosis: RawDiagnosisReply } | { readonly ok: false; readonly refusal: string } {
  if (reply === undefined) return { ok: false, refusal: 'the reviewer returned no output' }
  const parsed = parseReviewerObject(reply)
  if (parsed === undefined) return { ok: false, refusal: 'the reviewer returned no parseable json object' }
  const observation = textOf(parsed.observation)
  if (observation === undefined) return { ok: false, refusal: 'the reply carries no observation (the postmortem observation is required)' }
  const conclusion = textOf(parsed.conclusion)
  if (conclusion === undefined) return { ok: false, refusal: 'the reply carries no conclusion' }
  const confidence = parsed.confidence
  if (confidence !== 'high' && confidence !== 'medium' && confidence !== 'low') {
    return { ok: false, refusal: `the reply's confidence "${String(confidence)}" is not high/medium/low` }
  }
  try {
    return {
      ok: true,
      diagnosis: {
        observation,
        conclusion,
        confidence,
        judgements: judgementsOf(parsed.judgements),
        proposals: proposalsOf(parsed.proposals),
      },
    }
  } catch (error) {
    return { ok: false, refusal: `the reply's judgements or proposals are malformed: ${error instanceof Error ? error.message : String(error)}` }
  }
}

/** The judged dimensions rendered as report lines (agent judgements, kept apart from the fact lines). */
export function renderJudgements(judgements: readonly ReviewJudgement[]): string[] {
  return judgements.map(item => `  ${item.dimension}: ${item.verdict} — ${item.rationale} refs [${item.evidenceRefs.join(', ')}]`)
}

/** The diagnosis one attempt recorded, as the store holds it (the id is the attempt's session). */
export function recordedDiagnosis(snapshot: TaskSnapshot, sessionId: string): Diagnosis | undefined {
  return snapshot.diagnoses.find(diagnosis => diagnosis.diagnosisId === `review-agent-${sessionId}`)
}

/** Everything one attempt needs, resolved by the caller that means the source. */
export interface ReviewAttemptInput {
  readonly ctx: Context
  /** The root task store the attempt and the allowance belong to. */
  readonly storeId: string
  /** The exact source: the task and the run under review, or the no-run case. */
  readonly source: ReviewAgentSource
  /** The review record of that source, as the store holds it. */
  readonly review: ReviewRecord
  /** The reviewer's parent — the live agent whose spawn publishes the review node. */
  readonly parent: ReviewParentAgent
  /** The session that asked for the attempt (the caller). */
  readonly actor: string
  /** The caller's explicit key, or `null` for the source's default attempt. */
  readonly requestKey: string | null
  /** The review focus the caller named, or `null` when it named none. */
  readonly reason: string | null
  /** The caller's signal, when the attempt should end with it. */
  readonly signal?: AbortSignal
}

/** What one attempt ended as. */
export type ReviewAttemptOutcome =
  /** Refused by name before any claim or spawn (key conflict, new-key-required, allowance spent). */
  | { readonly kind: 'refused'; readonly plan: Extract<ReviewAgentPlan, { kind: 'refused' }>; readonly recovered: readonly ReviewAgentAttempt[] }
  /** The request is this source's attempt already: return it; nothing spawned, nothing written. */
  | { readonly kind: 'reuse'; readonly attempt: ReviewAgentAttempt; readonly recovered: readonly ReviewAgentAttempt[] }
  /** Another attempt of the source is not settled and is being run here: the request was not accepted. */
  | { readonly kind: 'in-flight'; readonly attempt: ReviewAgentAttempt; readonly recovered: readonly ReviewAgentAttempt[] }
  /** The spawn failed before any model input: the attempt is recorded interrupted. */
  | { readonly kind: 'spawn-failed'; readonly failure: string; readonly sessionId: string }
  /** The diagnosis was produced and the store refused it: the attempt is interrupted, the reviewer did run. */
  | { readonly kind: 'unrecorded'; readonly failure: string; readonly sessionId: string }
  /** The reviewer ended without a diagnosis: it was cancelled, or what it returned carries none (see {@link parseReviewerDiagnosis}). The attempt is settled `interrupted` with the reason named — no Diagnosis is */
  | { readonly kind: 'no-diagnosis'; readonly failure: string; readonly sessionId: string }
  /** The reviewer ran and its diagnosis is on the store: the attempt is settled `recorded`. */
  | {
    readonly kind: 'recorded'
    readonly sessionId: string
    readonly diagnosisId: string
    readonly confidence: DiagnosisConfidence
    /** The postmortem observation the reviewer wrote (the stored `observedFailure`). */
    readonly observation: string
    /** The conclusion in the reviewer's own words (the stored `localizedCause`). */
    readonly conclusion: string
    readonly judgements: readonly ReviewJudgement[]
    readonly proposals: readonly DiagnosisProposal[]
  }

/** Run one review attempt for one source: the admission's serial region (plan, claim, spawn) and then, outside it, the reviewer's reply, the diagnosis it carries and the one terminal fact. */
export async function runReviewAgentAttempt(input: ReviewAttemptInput): Promise<ReviewAttemptOutcome> {
  const { ctx, storeId, source, review, parent, actor } = input
  const reviewerSessionId = SessionId(randomUUID())
  const request: ReviewAgentAttemptRequest = {
    source,
    requestKey: input.requestKey,
    reason: input.reason,
    actor,
    sessionId: reviewerSessionId,
  }
  const outcome = await admitReviewAgent(storeId, async admission => {
    // The store, read inside the region: the pack the reviewer judges from, and
    // the one fact the ledger cannot see — whether an attempt whose row is open
    const current: TaskSnapshot = await ctx.task.snapshotIn(storeId)
    const { plan, recovered } = await admission.plan(request, {
      recorded: attempt => recordedDiagnosis(current, attempt.sessionId) !== undefined,
    })
    if (plan.kind === 'refused') return { kind: 'refused' as const, plan, recovered }
    if (plan.kind === 'reuse') return { kind: 'reuse' as const, attempt: plan.attempt, recovered }
    if (plan.kind === 'in-flight') return { kind: 'in-flight' as const, attempt: plan.attempt, recovered }
    const spawned = await spawnUnderClaim({
      ctx,
      admission,
      storeId,
      request,
      sessionId: reviewerSessionId,
      taskId: source.taskId,
      actor,
      parent,
      name: `review ${source.taskId}`,
      preset: REVIEWER_PRESET,
      grant: reviewerGrant(),
      signal: input.signal,
      errorLabel: 'task_review_agent: the delegation of reviewer session',
      failureLabel: 'spawn failed',
      prompt: async () => {
        const attempts = await readReviewAgentAttempts(storeId)
        const pack = buildReviewPack({
          snapshot: current,
          source,
          attempts,
          handoff: await handoffFactsOf(storeId, attempts),
        })
        return [
          'You are a Singularity review agent. Explain the review source below: what happened, why, and what — if anything — should change.',
          'Read what you are authorized to read: the pack below, and beyond it whatever settles the question — task_read, task_status and ' +
          'context_read reach the sibling tasks, their sessions and their evidence. Cite what you rest on.',
          'Do not score, and do not modify anything.',
          ...(review.outcome === 'verified'
            ? ['The run passed its review; look for improvement opportunities — what could be better, and whether an improvement round is worth it.']
            : []),
          'Return EXACTLY one fenced json block, no prose around it:',
          '```json',
          '{"observation":"...","conclusion":"...","confidence":"high|medium|low"}',
          '```',
          '- observation (required): the postmortem observation (复盘观察) — what was actually observed in the source, whether it failed or succeeded.',
          '- Keep observation and conclusion concise; cite the failure command, log or session ref rather than restating the whole pack.',
          '- conclusion (required): explain the cause and cite the original failure evidence. For a failed source, name one concrete next action for its business coordinator, such as a smaller independently verifiable child result after the batch settles. Check its task/run state first: task_decompose needs an active run; a terminal run needs a named stop and escalation, not another retry. If the evidence does not settle the cause, say what fact is missing and stop there.',
          '- confidence (required): high, medium or low.',
          '- A successful source may conclude "no improvement needed"; do not invent a failure or a next action.',
          `- judgements (optional): [{dimension, verdict, evidenceRefs, rationale}], only when useful and supported. Dimensions: ${JUDGED_DIMENSIONS.join(', ')}; verdict: adequate|inadequate|unknown. Do not fill every dimension.`,
          '- proposals (optional): [{targetType, targetId, rationale}]. A business retry or re-decomposition belongs in the conclusion. Suggest a skill or capability change only when the evidence establishes that gap; most failures need no evolution proposal. Nothing here executes a proposal.',
          '- Never tell the business coordinator to call task_recover: only a separately delegated supervisor has it. Recommend evolution tools only to a coordinator whose current tools authorize them, for an established skill/capability gap; they are not general task recovery.',
          'A reply without an observation, a conclusion or a confidence is not a diagnosis: the attempt is recorded interrupted and nothing is stored.',
          '',
          `--- source under review ---`,
          `review ${sourceRef(source)} [${review.outcome}]${request.reason === null ? '' : ` — focus: ${request.reason}`}`,
          '',
          '--- review pack ---',
          pack,
        ].join('\n')
      },
    })
    if (spawned.kind === 'spawn-failed') {
      return { kind: 'spawn-failed' as const, failure: spawned.failure, sessionId: reviewerSessionId }
    }
    return { kind: 'spawned' as const, handle: spawned.handle }
  })
  if (outcome.kind === 'refused' || outcome.kind === 'reuse' || outcome.kind === 'in-flight' || outcome.kind === 'spawn-failed') {
    return outcome
  }
  const { handle } = outcome

  /** The one exit an attempt has: every path that ends this execution records its terminal fact, so no failure of this entry leaves the source looking in flight forever. A ledger that cannot take the fact is best-effort */
  const settleAttempt = async (status: ReviewAgentSettlementStatus, note?: string) => {
    await settleReviewAgentAttempt({
      rootStoreId: storeId, taskId: source.taskId, sessionId: reviewerSessionId, status,
      ...(note === undefined ? {} : { note }),
    }).catch(() => undefined)
  }
  const cancel = () => handle.agent.cancel({ kind: 'parent' })
  input.signal?.addEventListener('abort', cancel, { once: true })
  let waiting = true
  let unloaded = false
  let resolveCompleted!: () => void
  const completed = new Promise<void>(resolve => { resolveCompleted = resolve })
  let disposeWait: (() => void | Promise<void>) | undefined
  try {
    // The plugin owns this wait. Unload cancels its reviewer and waits for the
    // attempt's terminal fact; no elapsed-time limit ends the model's work.
    disposeWait = ctx.effect(() => async () => {
      if (!waiting) return
      unloaded = true
      cancel()
      await completed
    }, 'singularityAgent: review agent wait')
    await handle.agent.whenIdle()
    const parsed = input.signal?.aborted === true || unloaded
      ? {
        ok: false as const,
        refusal: unloaded
          ? 'the plugin was unloaded before the reviewer produced a diagnosis'
          : 'the attempt was cancelled before the reviewer produced a diagnosis',
      }
      : parseReviewerDiagnosis(lastAssistantText(handle.agent.session.snapshotEvents()))
    if (!parsed.ok) {
      // Nothing is invented out of silence: the attempt's terminal fact says
      // what ended it, and the store holds no Diagnosis for it.
      await settleAttempt('interrupted', parsed.refusal)
      return { kind: 'no-diagnosis' as const, sessionId: reviewerSessionId, failure: parsed.refusal }
    }
    const { observation, conclusion, confidence, judgements, proposals } = parsed.diagnosis
    const diagnosis: Diagnosis = {
      diagnosisId: `review-agent-${reviewerSessionId}`,
      taskId: source.taskId,
      // The persisted `observedFailure` slot read as what it is here: the
      // postmortem observation the reviewer wrote, for a failed source and a
      observedFailure: observation,
      scope: `task ${source.taskId}`,
      localizedCause: conclusion,
      evidenceRefs: review.evidenceRefs,
      reviewRefs: [sourceRef(source)],
      confidence,
      proposals,
      producedBy: { kind: 'agent', sessionId: reviewerSessionId },
      ...(judgements.length === 0 ? {} : { judgements }),
    }
    try {
      await ctx.task.recordDiagnosisIn(storeId, diagnosis, actor)
    } catch (error) {
      await settleAttempt('interrupted', `the diagnosis could not be recorded: ${error instanceof Error ? error.message : String(error)}`)
      return {
        kind: 'unrecorded' as const,
        sessionId: reviewerSessionId,
        failure: error instanceof Error ? error.message : String(error),
      }
    }
    await settleAttempt('recorded')
    // Consume shared or root work after the diagnosis is durable; ordinary child work stays with its parent.
    await consumeHandoffDiagnosis(ctx, storeId, diagnosis.diagnosisId).catch((error: unknown) => {
      logOf(ctx, 'singularity-agent')?.warn(
        `evolution hand-off: ${diagnosis.diagnosisId} could not be consumed (${message(error)})`,
      )
    })
    return {
      kind: 'recorded' as const,
      sessionId: reviewerSessionId,
      diagnosisId: diagnosis.diagnosisId,
      confidence,
      observation,
      conclusion,
      judgements,
      proposals,
    }
  } catch (error) {
    cancel()
    await settleAttempt('interrupted', `the review attempt failed: ${error instanceof Error ? error.message : String(error)}`)
    throw error
  } finally {
    waiting = false
    resolveCompleted()
    input.signal?.removeEventListener('abort', cancel)
    if (!unloaded) await disposeWait?.()
  }
}
