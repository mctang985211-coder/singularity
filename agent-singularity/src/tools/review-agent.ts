/**
 * `task_review_agent`: spawn one read-only review agent for a task whose review
 * facts are not enough, take its structured judgement of the six dimensions no
 * parser can settle, and persist it as a `Diagnosis`.
 *
 * Why an agent and not a parser (§2.7.3, and the owner's ruling): extracting
 * "was this specification adequate" from a complex context is not a parsing
 * problem, it is a judgement problem, and a review agent is the tool for it.
 * Why not a resident reviewer (§2.7.2): one agent per task would multiply
 * sessions and storage, so this tool only runs when `task_review_pack`'s
 * escalation criterion fires and the per-root-store budget still has room.
 *
 * Isolation is the tool plane, not the permission preset: the child is granted
 * exactly {@link REVIEWER_BASELINE} (`keepPresetTools: false`, so the mounted
 * preset contributes nothing), which carries no shell, no write, no nested
 * spawn, and no evolution tool. The permission preset is left at the spawn
 * default — deliberately NOT `read-only`, whose `approval: ask` would hang an
 * unattended reviewer on a human decision (base bundle `cordis.patch.yml:230`)
 * — because with nothing policy-gated there is nothing to approve.
 *
 * The judgement is not a score: each dimension settles `adequate` /
 * `inadequate` / `unknown`, cites the refs it rests on, and explains itself.
 * Evidence that does not settle a dimension becomes `unknown`, never a guess.
 * @module @dangosys/dsh-singularity-agent/tools/review-agent
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {} from '@dangosys/dsh-singularity-graphs'
import type { WorkerGrant } from '@dangosys/dsh-singularity-agent-runtime'
import type {} from '@dangosys/dsh-singularity-task'
import type { Diagnosis, DiagnosisConfidence, JudgementVerdict, ReviewJudgement, TaskId, TaskSnapshot } from '@dangosys/dsh-singularity-task'
import { JUDGED_DIMENSIONS, JUDGEMENT_VERDICTS, rootTaskStoreId } from '@dangosys/dsh-singularity-task'
import { appendReviewAgentRun, countReviewAgentRuns, reviewAgentBudget } from '../review-agent-ledger.ts'
import { computeEscalation } from './review-escalation.ts'
import { buildReviewPack, latestReview, reviewRef } from './task-review-pack.ts'

const text = (value: string) => [{ type: 'text' as const, text: value }]

/** The preset the review agent mounts (`$DSH_HOME/.agent-presets/singularity-reviewer/`). */
export const REVIEWER_PRESET = 'singularity-reviewer'

/**
 * The review agent's whole tool surface. Read-only by construction: the grant
 * allow-list is this list intersected with what the composition offers, so
 * `bash`, `write`, `edit`, `jobs`, `subagent`, `graph_spawn`, `hitl_*` and
 * `evolution_*` are absent however the deployment is composed. `session_trace`
 * and its siblings are here so the reviewer can drill into the sessions the
 * pack names, which is the point of printing session ids on every review line.
 */
export const REVIEWER_BASELINE: readonly string[] = [
  'task_review_pack',
  'task_read',
  'task_status',
  'capability_list',
  'session_event_read',
  'session_event_trace',
  'session_trace',
  'read',
  'glob',
  'grep',
  'skill',
]

/** The capability grant one review agent is spawned with. */
export function reviewerGrant(): WorkerGrant {
  return { capabilities: [], baseline: REVIEWER_BASELINE, keepPresetTools: false }
}

/** Default watchdog deadline for one review agent (10 minutes). */
export const REVIEW_AGENT_TIMEOUT_MS = 600_000

/** One raw judgement object as the reviewer wrote it, before validation. */
interface RawJudgement {
  dimension?: unknown
  verdict?: unknown
  evidenceRefs?: unknown
  rationale?: unknown
}

function sessionId(exec: ToolRunContext): SessionId {
  const id = exec.agent?.id
  if (typeof id !== 'string' || id.length === 0) throw new Error('task_review_agent: missing agent id')
  return id
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
 * Pull the judgement list out of the reviewer's reply. The last fenced block
 * wins, then the last balanced object; a reply with neither parses as nothing,
 * which the caller turns into six `unknown` judgements rather than a failure.
 */
function parseReviewerJudgements(reply: string | undefined): RawJudgement[] | undefined {
  if (reply === undefined) return undefined
  const fenced = [...reply.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map(match => match[1])
  const candidates = [fenced[fenced.length - 1], lastBalancedObject(reply)].filter((value): value is string => value !== undefined)
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate)
      const list = Array.isArray(parsed) ? parsed : (parsed as { judgements?: unknown } | null)?.judgements
      if (Array.isArray(list)) return list as RawJudgement[]
    } catch {
      // try the next candidate shape
    }
  }
  return undefined
}

/**
 * Normalize a reviewer reply into exactly one judgement per judged dimension.
 * Missing dimensions become `unknown`; a verdict outside the vocabulary becomes
 * `unknown`; and a judgement with no evidence ref is downgraded to `unknown`
 * with the review ref cited, because evidence that settles nothing must not
 * read as a conclusion.
 */
export function normalizeJudgements(
  raw: RawJudgement[] | undefined,
  fallbackRef: string,
  missingRationale: string,
): ReviewJudgement[] {
  return JUDGED_DIMENSIONS.map(dimension => {
    const entry = [...(raw ?? [])].reverse().find(item => item.dimension === dimension)
    if (entry === undefined) {
      return { dimension, verdict: 'unknown', evidenceRefs: [fallbackRef], rationale: missingRationale }
    }
    const refs = Array.isArray(entry.evidenceRefs)
      ? entry.evidenceRefs.filter((value): value is string => typeof value === 'string' && value.length > 0)
      : []
    const rationale = typeof entry.rationale === 'string' && entry.rationale.length > 0 ? entry.rationale : 'no rationale provided'
    const verdict: JudgementVerdict = JUDGEMENT_VERDICTS.includes(entry.verdict as JudgementVerdict)
      ? (entry.verdict as JudgementVerdict)
      : 'unknown'
    if (refs.length === 0) {
      return { dimension, verdict: 'unknown', evidenceRefs: [fallbackRef], rationale: `${rationale} (evidenceRefs empty — downgraded to unknown)` }
    }
    return { dimension, verdict, evidenceRefs: refs, rationale }
  })
}

/** A mechanical restatement of the judgements — what was concluded, not an invented cause. */
function renderCause(taskId: TaskId, judgements: readonly ReviewJudgement[]): string {
  const by = (verdict: JudgementVerdict) => judgements.filter(item => item.verdict === verdict).map(item => item.dimension)
  const parts: string[] = []
  for (const verdict of ['inadequate', 'unknown', 'adequate'] as const) {
    const dimensions = by(verdict)
    if (dimensions.length > 0) parts.push(`${verdict} [${dimensions.join(', ')}]`)
  }
  return `agent review of ${taskId}: ${parts.join('; ')}`
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

export function defineTaskReviewAgentTool(ctx: Context) {
  return defineTool({
    name: 'task_review_agent',
    description:
      'Spawn ONE read-only review agent for a task, take its structured judgement of the six dimensions the fact ' +
      'table cannot settle (task_specification, acceptance, decomposition, skill_fit, tool_fit, context_efficiency), ' +
      'and persist that judgement as a Diagnosis. Each dimension returns verdict adequate|inadequate|unknown, required ' +
      'evidence refs, and a rationale — never a score; evidence that does not settle a dimension must be unknown. ' +
      'The reviewer has no write, shell, spawn, or evolution tool. It runs only when task_review_pack\'s escalation ' +
      'criterion fires, is capped per root store (default 1), and is cancelled by a watchdog if it overruns.',
    parameters: {
      taskId: { type: 'string', required: true, description: 'Task whose review needs judgement' },
      timeoutMs: { type: 'number', description: `Watchdog deadline in milliseconds; defaults to ${REVIEW_AGENT_TIMEOUT_MS}` },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    execute: async (args, exec) => {
      const caller = sessionId(exec)
      const graph = await ctx.graphs.graphForSession(caller)
      const storeId = rootTaskStoreId(graph.rootSessionId)
      const snapshot: TaskSnapshot = await ctx.task.openStore(storeId)
      const task = snapshot.tasks.find(item => item.taskId === args.taskId)
      if (task === undefined) return `task_review_agent: unknown task "${args.taskId}"`
      const review = latestReview(snapshot, args.taskId)
      if (review === undefined) {
        return `task_review_agent: task ${args.taskId} has no review record; nothing to judge`
      }
      const max = reviewAgentBudget()
      const used = await countReviewAgentRuns(storeId)
      const escalation = computeEscalation(snapshot, args.taskId, { used, max })
      if (escalation.suppressed.length > 0) {
        return `task_review_agent: budget exhausted (${used}/${max}) for store ${storeId}; suppressed ${escalation.suppressed.join(', ')} — no review agent spawned`
      }
      if (!escalation.required) {
        return `task_review_agent: escalation is not required for task ${args.taskId} (budget ${used}/${max}); no review agent spawned`
      }
      const timeoutMs = Number.isFinite(args.timeoutMs) && (args.timeoutMs as number) > 0
        ? Math.floor(args.timeoutMs as number)
        : REVIEW_AGENT_TIMEOUT_MS
      const ref = reviewRef(review)
      const pack = buildReviewPack(snapshot, args.taskId, escalation)
      const prompt = [
        'You are a Singularity review agent. Judge six dimensions of the task below from the review pack, and nothing else.',
        'Do not score. Do not modify anything. Cite only refs printed in the pack (evidence ids, review refs like `task#run`, or session ids).',
        'When the pack does not settle a dimension, return verdict "unknown" — never guess.',
        'Return EXACTLY one fenced json block, no prose around it:',
        '```json',
        '{"judgements":[{"dimension":"task_specification","verdict":"adequate|inadequate|unknown","evidenceRefs":["..."],"rationale":"..."}]}',
        '```',
        `Include all six dimensions exactly once: ${JUDGED_DIMENSIONS.join(', ')}.`,
        '',
        '--- review pack ---',
        pack,
      ].join('\n')

      const reviewerSessionId = SessionId(randomUUID())
      let spawnFailure: string | undefined
      const handle = await ctx.agentRuntime.spawn(exec.agent!, {
        sessionId: reviewerSessionId,
        name: `review ${args.taskId}`,
        prompt: [{ type: 'text', text: prompt }],
        agentPreset: REVIEWER_PRESET,
        grant: reviewerGrant(),
        signal: exec.signal,
      }).catch((error: unknown) => {
        spawnFailure = error instanceof Error ? error.message : String(error)
        return undefined
      })
      if (handle === undefined) return `task_review_agent: spawn failed: ${spawnFailure ?? 'unknown error'}`
      await appendReviewAgentRun({ rootStoreId: storeId, taskId: args.taskId, sessionId: reviewerSessionId, actor: caller })

      const cancel = () => handle.agent.cancel({ kind: 'parent' })
      exec.signal.addEventListener('abort', cancel, { once: true })
      let timer: ReturnType<typeof setTimeout> | undefined
      let timedOut = false
      const deadline = new Promise<'timeout'>(resolve => {
        timer = setTimeout(() => {
          timedOut = true
          resolve('timeout')
        }, timeoutMs)
      })
      // A rejecting `whenIdle` is treated like a silent reviewer: the reply is
      // read (likely absent) and the judgement degrades to `unknown` rather
      // than throwing out of the tool.
      const idle = handle.agent.whenIdle().then(() => 'idle' as const).catch(() => 'failed' as const)
      const outcome = await Promise.race([idle, deadline])
      if (timer !== undefined) clearTimeout(timer)
      exec.signal.removeEventListener('abort', cancel)
      if (outcome === 'timeout') handle.agent.cancel({ kind: 'parent' })

      const reply = timedOut ? undefined : lastAssistantText(handle.agent.session.snapshotEvents())
      const parsed = timedOut ? undefined : parseReviewerJudgements(reply)
      const missingRationale = timedOut
        ? `review agent timed out after ${timeoutMs}ms with no judgement`
        : 'no judgement returned for this dimension'
      const judgements = normalizeJudgements(parsed, ref, missingRationale)
      const confidence: DiagnosisConfidence = timedOut || parsed === undefined ? 'low' : judgements.some(item => item.verdict === 'unknown') ? 'medium' : 'high'
      const diagnosis: Diagnosis = {
        diagnosisId: `review-agent-${reviewerSessionId}`,
        taskId: args.taskId,
        observedFailure: review.localizedCause ?? review.anomalies[0] ?? `escalation ${escalation.reasons.join(', ')} fired with no terminal failure text`,
        scope: `task ${args.taskId}`,
        localizedCause: renderCause(args.taskId, judgements),
        evidenceRefs: review.evidenceRefs,
        reviewRefs: [ref],
        confidence,
        proposals: [],
        producedBy: { kind: 'agent', sessionId: reviewerSessionId },
        judgements,
      }
      try {
        await ctx.task.recordDiagnosisIn(storeId, diagnosis, caller)
      } catch (error) {
        return `task_review_agent: judgement produced but not recorded: ${error instanceof Error ? error.message : String(error)}`
      }
      const head = timedOut
        ? `task_review_agent: review agent ${reviewerSessionId} timed out after ${timeoutMs}ms; cancelled. All six dimensions recorded unknown.`
        : `task_review_agent: review agent ${reviewerSessionId} judged task ${args.taskId} (escalation ${escalation.reasons.join(', ') || 'none'})`
      return [
        head,
        `judgements (agent ${reviewerSessionId}):`,
        ...renderJudgements(judgements),
        `diagnosis ${diagnosis.diagnosisId} recorded [${confidence}]`,
      ].join('\n')
    },
  })
}
