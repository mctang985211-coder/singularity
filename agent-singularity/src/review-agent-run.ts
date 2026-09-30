/**
 * One review attempt, from its claim to its settled fact — the entry both
 * triggers share (A5).
 *
 * The tool (`tools/review-agent.ts`) is the explicit door: a model call that
 * names one source. The automatic scan (`review-agent-scan.ts`) is the other:
 * a review that settled `failed` is accepted under the store's own allowance.
 * Both run *the same attempt* — the admission's serial region, the claim written
 * before the reviewer exists, the pack, the spawn, the diagnosis
 * and the one terminal fact — so the two doors cannot drift into two review
 * implementations.
 *
 * What stays with the caller is what only the caller knows: which source it
 * means (the tool validates the task, the run and the review record; the scan
 * takes them from the store), who the parent of the reviewer is, and how the
 * outcome is rendered — a model-facing answer for the tool, a named line for the
 * scan. This module decides nothing about *whether* a review should happen: the
 * source is given, and the ledger decides whether this request is a new attempt,
 * a repeat, or a refusal.
 *
 * Isolation is the tool plane, not the permission preset: the child is granted
 * exactly {@link REVIEWER_BASELINE} (`keepPresetTools: false`, so the mounted
 * preset contributes nothing), which carries no shell, no write, no nested
 * spawn, and no evolution tool. The permission preset is left at the spawn
 * default — deliberately NOT `read-only`, whose `approval: ask` would hang an
 * unattended reviewer on a human decision (base bundle `cordis.patch.yml:230`)
 * — because with nothing policy-gated there is nothing to approve.
 *
 * The pack is where the reviewer *starts*, not what it is confined to (A5 §3):
 * it reads the source itself through `context_read`, `task_read` and
 * `task_status`, and cites what it rests on. What it returns is a diagnosis —
 * an observation, a conclusion in its own words ("no improvement needed" and
 * "the evidence does not settle this" are conclusions), an honest confidence,
 * and, only when it really made them, judgements and proposals. The six
 * dimensions are a vocabulary, not a form: a reply that judges two of them is
 * complete, and no dimension is ever padded with `unknown`.
 *
 * Nothing here invents a record. A cancellation, a reply that is not a diagnosis, and a judgement that cites nothing are all
 * **interrupted attempts with a named reason** — the ledger holds that fact,
 * and the store holds no Diagnosis, because an `unknown` an agent never wrote
 * is not a conclusion it reached.
 *
 * The same applies to an attempt *this* entry never ran: a row left open by a
 * process that died holding it is recovered by the ledger's admission — recorded
 * `interrupted`, or `recorded` when the store already holds its diagnosis — so
 * one crashed reviewer cannot pin its source in flight forever. This entry only
 * hands the admission the one fact it cannot see by itself: whether the store
 * has that diagnosis (the `recorded` hook below).
 * @module @dangosys/dsh-singularity-agent/review-agent-run
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
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
import {
  admitReviewAgent,
  countReviewAgentRuns,
  readReviewAgentAttempts,
  readReviewerDelegation,
  reviewAgentBudget,
  settleReviewAgentAttempt,
  type ReviewAgentAttempt,
  type ReviewAgentAttemptRequest,
  type ReviewAgentPlan,
  type ReviewAgentSettlementStatus,
  type ReviewAgentSource,
} from './review-agent-ledger.ts'
import { consumeHandoffDiagnosis } from './evolution-handoff.ts'
import { evolutionEnabled } from './handoff-rules.ts'
import { buildReviewPack, reviewRef } from './tools/task-review-pack.ts'

/** The preset the review agent mounts (`$DSH_HOME/.agent-presets/singularity-reviewer/`). */
export const REVIEWER_PRESET = 'singularity-reviewer'

/**
 * The review agent's whole tool surface. Read-only by construction: the grant
 * allow-list is this list intersected with what the composition offers, so
 * `bash`, `write`, `edit`, `jobs`, `subagent`, `graph_spawn`, `hitl_*` and
 * `evolution_*` are absent however the deployment is composed. Session history
 * is read with `context_read` — the one reference reader, authorized by the
 * reviewer's delegated graph domain; the raw cross-session tools it replaced
 * are sealed on every runtime-owned agent (`agent-runtime`'s execution guard).
 */
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

/**
 * The live agent one reviewer spawns from — the shape `ToolRunContext.agent`
 * and the agent registry both answer with, without this package depending on
 * the agent plane's own module (it never does: agents arrive through a tool
 * call's context or through the registry).
 */
export type ReviewParentAgent = NonNullable<ToolRunContext['agent']>

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

/** The last top-level brace-balanced object in the text, if any (fallback when no fence parses). */
function lastBalancedObject(source: string): string | undefined {
  let depth = 0
  let start = -1
  let last: string | undefined
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    if (char === '{') {
      if (depth === 0) start = index
      depth += 1
    } else if (char === '}') {
      depth -= 1
      if (depth === 0 && start >= 0) last = source.slice(start, index + 1)
    }
  }
  return last
}

/**
 * The parsed reply object out of the reviewer's answer: the last fenced block
 * wins, then the last balanced object. A reply with neither parses as nothing.
 */
function parseReviewerObject(reply: string | undefined): Record<string, unknown> | undefined {
  if (reply === undefined) return undefined
  const fenced = [...reply.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map(match => match[1])
  const candidates = [fenced[fenced.length - 1], lastBalancedObject(reply)].filter((value): value is string => value !== undefined)
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
    } catch {
      // try the next candidate shape
    }
  }
  return undefined
}

/** A non-empty string out of the reply, or nothing. */
function textOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

/**
 * Validate the judgements the reviewer chose to make. Each one has to name a
 * judged dimension and a verdict from the fixed vocabulary, cite at least one
 * non-empty ref and carry a rationale — this is the store's own rule, checked
 * here so the attempt fails by name instead of being refused later. A verdict
 * outside the vocabulary is **not** softened into `unknown`: a conclusion the
 * reviewer never made is not one this module may write down.
 */
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

/**
 * The diagnosis the reviewer's reply carries, or a named reason it carries
 * none. What is required is what a Diagnosis is: the **observation** (the
 * persisted `observedFailure` slot, read as the postmortem observation — a
 * successful postmortem fills in what really happened, never an invented
 * failure), the **conclusion** in the reviewer's own words, and a confidence.
 * What is optional is what a conclusion need not carry: judgements (only the
 * dimensions the reviewer can settle) and proposals (an empty list is the
 * normal answer for "no improvement needed").
 */
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

function lastAssistantText(events: readonly { type: string; data?: unknown }[]): string | undefined {
  const event = [...events].reverse().find(item => item.type === 'assistant/message')
  if (event === undefined) return undefined
  const message = (event.data as { message?: { content?: readonly { type: string; text?: string }[] } } | undefined)?.message
  const content = (message?.content ?? []).filter(block => block.type === 'text').map(block => block.text ?? '').join('\n')
  return content.length === 0 ? undefined : content
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
  /**
   * The reviewer ended without a diagnosis: it was cancelled, or
   * what it returned carries none (see {@link parseReviewerDiagnosis}). The
   * attempt is settled `interrupted` with the reason named — no Diagnosis is
   * invented out of silence (A5).
   */
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

/**
 * Run one review attempt for one source: the admission's serial region (plan,
 * claim, spawn) and then, outside it, the reviewer's reply, the diagnosis it
 * carries and the one terminal fact.
 *
 * Waiting for the reviewer never runs inside the region: only the decision, the
 * claim and the spawn do, so the claim is durable before any handle exists and a
 * second admission for the same store cannot slip a claim in between the read
 * and the write. The caller's caller (a tool call, a scan) is free to do
 * anything else while the reviewer works.
 */
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
    // already put its diagnosis on the record. An attempt that did ended
    // `recorded` however its terminal row is missing.
    const current: TaskSnapshot = await ctx.task.snapshotIn(storeId)
    const { plan, recovered } = await admission.plan(request, {
      recorded: attempt => recordedDiagnosis(current, attempt.sessionId) !== undefined,
    })
    if (plan.kind === 'refused') return { kind: 'refused' as const, plan, recovered }
    if (plan.kind === 'reuse') return { kind: 'reuse' as const, attempt: plan.attempt, recovered }
    if (plan.kind === 'in-flight') return { kind: 'in-flight' as const, attempt: plan.attempt, recovered }
    await admission.claim(request)
    const attempts = await readReviewAgentAttempts(storeId)
    const pack = buildReviewPack({
      snapshot: current,
      source,
      attempts,
      handoff: {
        enabled: evolutionEnabled(ctx),
        attempts,
        budget: { used: await countReviewAgentRuns(storeId), max: reviewAgentBudget() },
      },
    })
    const prompt = [
      'You are a Singularity review agent. Explain the review source below: what happened, why, and what — if anything — should change.',
      'Read what you are authorized to read: the pack below, and beyond it whatever settles the question — task_read, task_status and ' +
      'context_read reach the sibling tasks, their sessions and their evidence. Cite what you rest on.',
      'Do not score, and do not modify anything.',
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

    let spawnFailure: string | undefined
    const handle = await ctx.agentRuntime.spawn(parent, {
      sessionId: reviewerSessionId,
      name: `review ${source.taskId}`,
      prompt: [{ type: 'text', text: prompt }],
      agentPreset: REVIEWER_PRESET,
      grant: reviewerGrant(),
      // The delegation ledger is written between "the reviewer is a published
      // graph member" and "its first model input" (A2 §D): the context
      // assembly verifies the delegation from this ledger, so it must be
      // durable — written AND read back — before any model request exists. A
      // failure here fails the spawn: the handle is disposed, the node is
      // marked failed, and the reviewer got zero model input.
      beforePrompt: async () => {
        await admission.start({ taskId: source.taskId, sessionId: reviewerSessionId, actor })
        // The row is durable, so this run is spent whether or not the spawn
        // survives the read-back below — and whether or not the reviewer
        // ever answers.
        const back = await readReviewerDelegation(reviewerSessionId)
        if (back === undefined || back.rootStoreId !== storeId || back.taskId !== source.taskId) {
          throw new Error(
            `task_review_agent: the delegation of reviewer session "${reviewerSessionId}" could not be read back from the ledger ` +
            `(expected task ${source.taskId} in ${storeId}); no model input was sent`,
          )
        }
      },
      signal: input.signal,
    }).catch((error: unknown) => {
      spawnFailure = error instanceof Error ? error.message : String(error)
      return undefined
    })
    if (handle === undefined) {
      // A spawn that failed before its started row wrote no spend — but its
      // claim stands, and the attempt is over: recording that is what keeps
      // the source from looking in flight forever.
      await settleReviewAgentAttempt({
        rootStoreId: storeId, taskId: source.taskId, sessionId: reviewerSessionId,
        status: 'interrupted', note: `spawn failed: ${spawnFailure ?? 'unknown error'}`,
      }).catch(() => undefined)
      return { kind: 'spawn-failed' as const, failure: spawnFailure ?? 'unknown error', sessionId: reviewerSessionId }
    }
    return { kind: 'spawned' as const, handle }
  })
  if (outcome.kind === 'refused' || outcome.kind === 'reuse' || outcome.kind === 'in-flight' || outcome.kind === 'spawn-failed') {
    return outcome
  }
  const { handle } = outcome

  /**
   * The one exit an attempt has: every path that ends this execution records
   * its terminal fact, so no failure of this entry leaves the source looking
   * in flight forever. A ledger that cannot take the fact is best-effort
   * here — an attempt that recorded its diagnosis is found again by the
   * store's own record of it.
   */
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
      // successful one alike (A5 §4).
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
    // The hand-off (A6): a diagnosis that carries suggestions is what the
    // evolution plane consumes, and this is the one place that knows the record
    // just became durable. Nothing is awaited — the review's answer does not
    // depend on a coordinator being started, and a hand-off that cannot start
    // stays readable as the pending hand-off it is.
    if (diagnosis.proposals.length > 0) {
      void consumeHandoffDiagnosis(ctx, storeId, diagnosis.diagnosisId).catch((error: unknown) => {
        const logger = (ctx as { logger?: (name: string) => { warn(format: string): void } }).logger
        logger?.('singularity-agent').warn(
          `evolution hand-off: ${diagnosis.diagnosisId} could not be consumed (${error instanceof Error ? error.message : String(error)})`,
        )
      })
    }
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
