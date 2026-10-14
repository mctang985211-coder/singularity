import { REVIEW_PROTOCOL, REVIEW_VERSION, type ReviewRun } from '../../src/review/protocol.ts'
import { setTimeout } from 'node:timers/promises'
import type { ChildSession } from '../../src/runtime/child-session.ts'
import { childSettled, projectTree, type TreeView } from '../../src/task/tree.ts'
import { refuse } from '../../src/protocol/refusal.ts'
import { AGENT_PROTOCOL, AGENT_VERSION, type AgentState } from '../../src/agent/protocol.ts'
import { ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION, type EnvironmentState } from '../../src/environment/protocol.ts'
import { TASK_PROTOCOL, TASK_VERSION, type RevisionRef, type RunState, type RunSubmission, type TaskState,
} from '../../src/task/protocol.ts'
import type { TaskContract } from '../../src/task/contract.ts'
import { projectReceipt, projectTask, type ReceiptView, type RunView, type TaskView } from '../../src/task/view.ts'
import type { RoundDecision } from '../../src/strategy/view.ts'
import { taskStateOf, type Apparatus } from './apparatus.ts'
import { methodEnvironment, type MethodAssets } from './method.ts'

import { digestOf } from '../../src/protocol/envelope.ts'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { sealedBytes } from './sealed.ts'
import type { TaskTemplate } from './template.ts'
import { MEASURE_PROTOCOL, MEASURE_VERSION, type EvaluationState } from '../../src/measure/protocol.ts'
import { parentPlan, waitingReason, readScopeOf } from './coordination.ts'

export function planOutcomeOf(apparatus: Apparatus, plan: TreeView) {
  const complete = plan.children.every(childSettled)
  if (!complete) return undefined
  const ids = new Set(plan.children.map((c) => c.taskId))
  const fact = apparatus.store.load().entries().findLast((fact) =>
    (ids.has(fact.subject) && (fact.kind === 'run/verified' || fact.kind === 'run/failed')) ||
    (fact.subject === plan.parentTaskId && (fact.kind === 'task/decomposed' || fact.kind === 'review/decomposed')))
  if (fact === undefined) refuse('illegal-transition', `plan "${plan.parentTaskId}" has no terminal fact for its outcome`)
  return fact
}
export async function outcomesAnswered(apparatus: Apparatus, sessionId: string, parentId: string,
  factSeqs: readonly number[],
  purpose: 'plan-outcome' | 'answer' = 'plan-outcome',
): Promise<boolean> {
  const handle = await apparatus.persistence.open(SessionId(sessionId), 'read')
  try {
    const { events } = await handle.read()
    return factSeqs.every((seq) => {
      const entered = events.findIndex((event) => event.type === 'user/message' &&
        event.data.source.kind === 'singularity' && event.data.source.purpose === purpose &&
        event.data.source.controlId === apparatus.controlId &&
        (purpose === 'answer' ? event.data.source.taskId === parentId : event.data.source.parentTaskId === parentId) &&
        event.data.source.factSeq === seq)
      return entered >= 0 && events.slice(entered + 1).some((event) => event.type === 'turn/end')
    })
  } finally { await handle.close() }
}

export interface TemplateDeclaration {
  readonly id: string
  readonly goal: string
  readonly applicability?: string
  readonly decomposition?: TaskTemplate['decomposition']
  readonly skills: readonly string[]
  readonly capabilities: readonly string[]
  readonly input: TaskTemplate['input']
  readonly workspace: { readonly artifact: string; readonly initialContent?: string }
  readonly criterion: { readonly criterionId: string; readonly statement: string; readonly verifier?: string }
}
export function templateDeclaration(template: TaskTemplate): TemplateDeclaration {
  return { id: template.id, skills: template.skills, capabilities: template.capabilities, goal: template.goal, input: template.input,
    ...(template.applicability === undefined ? {} : { applicability: template.applicability }),
    ...(template.decomposition === undefined ? {} : { decomposition: template.decomposition }),
    workspace: {
      artifact: template.artifact, ...(template.initial === undefined ? {} : { initialContent: Buffer.from(template.initial.bytes).toString('utf8') }),
    },
    criterion: { criterionId: template.criterion.criterionId, statement: template.criterion.statement,
      ...(template.verifier === undefined ? {} : { verifier: template.verifier.ref }),
    },
  }
}

export interface ReadRun extends RunView {
  readonly receipt: ReceiptView | null
  readonly artifact: FileAttachmentRef | null
  readonly source: RunSubmission['source'] | null
}
export interface ReadTask extends Omit<TaskView, 'runs'> {
  readonly contract: TaskContract
  readonly agentId: string | null
  readonly sessionId: string | null
  readonly decomposition: TaskState['decomposition'] | null
  readonly runs: readonly ReadRun[]
  readonly parent: ReturnType<typeof parentPlan> | null
  readonly questions: TaskState['questions']
  readonly waiting: string | null
}
export interface MethodHistory {
  readonly tasks: readonly ReadTask[]
  readonly methods: readonly { readonly reference: RevisionRef; readonly assets: MethodAssets }[]
  readonly decisions: readonly RoundDecision[]
}

export async function readTask(apparatus: Apparatus, state: TaskState): Promise<ReadTask> {
  const view = projectTask(state)
  const committed = apparatus.store.load()
  const owner = state.responsibility === undefined ? undefined : committed.stateOf<AgentState>(AGENT_PROTOCOL, AGENT_VERSION, state.responsibility.agentId)
  const runs = await Promise.all(view.runs.map(async (run) => {
    const submission = state.runs[run.runId]!.submission
      return {
        ...run, artifact: submission?.files.artifact ?? null, source: submission?.source ?? null,
      receipt: run.status === 'running' ? null : projectReceipt(apparatus.registry, committed.entries(), state.taskId, run.runId),
      }
    }),
  )
  return { ...view, contract: state.contract!, agentId: state.responsibility?.agentId ?? null,
    sessionId: owner?.sessionId ?? null, decomposition: state.decomposition ?? null, runs,
    parent: parentPlan(apparatus, state.taskId) ?? null, questions: state.questions,
    waiting: waitingReason(apparatus, state.taskId) ?? null,
  }
}


export async function readArtifact(apparatus: Apparatus, taskId: string, runId?: string, from = 0, count = 16_384) {
  if (!Number.isSafeInteger(from) || from < 0 || !Number.isSafeInteger(count) || count < 4 || count > 32_768)
    refuse('malformed-declaration', 'artifact pages require a nonnegative byte offset and 4 to 32768 bytes')
  const task = taskStateOf(apparatus, taskId)
  const run = runId === undefined
    ? Object.values(task.runs).findLast((run) => run.status === 'verified') ??
      Object.values(task.runs).findLast((run) => run.submission !== undefined)
    : task.runs[runId]
  if (run?.submission === undefined) refuse('unknown-run', 'the selected Run has no sealed artifact')
  const artifact = run.submission.files.artifact
  const bytes = await sealedBytes(apparatus, artifact)
  if (from > bytes.length || (from < bytes.length && (bytes[from]! & 0xc0) === 0x80))
    refuse('malformed-declaration', 'artifact offset must be a UTF-8 character boundary within the sealed bytes')
  let end = Math.min(bytes.length, from + count)
  while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(from, end))
  return { taskId, runId: run.runId, status: run.status, artifact, digest: run.submission.artifactDigest,
    from, next: end, totalBytes: bytes.length, complete: end === bytes.length, text }
}

export async function historyOf(apparatus: Apparatus, decisions: readonly RoundDecision[], agentId?: string,
): Promise<MethodHistory> {
  const committed = apparatus.store.load()
  const states = committed.statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION)
  const { visible, revisions, audit } = await readScopeOf(apparatus, agentId, committed)
  const tasks = await Promise.all([...states.values()]
    .filter((task) => task.contract !== undefined && (visible === undefined || visible.has(task.taskId))).map((task) => readTask(apparatus, task)),
  )
  const library = committed.stateOf<EnvironmentState>(ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION, methodEnvironment(apparatus),
  )
  const methods = library === undefined ? [] : Object.values(library.revisions).filter((revision) => visible === undefined || revisions.has(revision.contentDigest)).map((revision) => ({
    reference: { environmentId: library.environmentId, revisionId: revision.revisionId, digest: revision.contentDigest,
            }, assets: revision.manifest as MethodAssets,
  }))
  return { tasks, methods, decisions: audit ? decisions : [] }
}

export async function waitForTask(apparatus: Apparatus, taskId: string, session: ChildSession, signal: AbortSignal,
): Promise<RunState> {
  while (true) {
    await session.wait()
    signal.throwIfAborted()
    const task = taskStateOf(apparatus, taskId)
    const run = Object.values(task.runs).at(-1)!
    if (run.status !== 'running') return run
    const tree = projectTree(apparatus.store.load().statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION))
      .find((plan) => plan.parentTaskId === taskId)
    if (tree?.children.some((child) => child.status === 'missing'))
      refuse('illegal-transition', 'delegated work has no admitted contract')
    if (waitingReason(apparatus, taskId) !== undefined || task.rounds?.some((r) => r.status === 'pending')) {
      await setTimeout(100, undefined, { signal })
      continue
    }
    const answers = (task.questions ?? []).filter((q) => q.runId === run.runId).flatMap((q) => q.answers.map((a) => a.seq))
    const outcomes = (task.rounds ?? []).map((r) => apparatus.store.committedOf(`round-settled:${r.roundId}`)!.seq)
    if (tree !== undefined) outcomes.push(planOutcomeOf(apparatus, tree)!.seq)
    if (await outcomesAnswered(apparatus, session.sessionId, taskId, answers, 'answer') &&
      await outcomesAnswered(apparatus, session.sessionId, taskId, outcomes))
      refuse('illegal-transition', 'the native agent stopped without submitting its working Run after coordination settled')
    await setTimeout(100, undefined, { signal })
  }
}

export async function readTrajectory(
  apparatus: Apparatus,
  agentId: string,
  sessionId: string,
  from = 0,
  count = 20,
): Promise<readonly unknown[]> {
  if (!Number.isSafeInteger(from) || from < 0 || !Number.isSafeInteger(count) || count < 1 || count > 100)
    refuse('malformed-declaration', 'trajectory range must use a nonnegative offset and 1 to 100 events per page')
  const cut = apparatus.store.load(),
    review = [...cut.statesOf<ReviewRun>(REVIEW_PROTOCOL, REVIEW_VERSION).values()].findLast(
      (r) => r.agentId === agentId,
    )
  let sessions: readonly { sessionId: string; events: readonly SessionEvent[] }[] = []
  if (review !== undefined) {
    const evidenceIds = new Set<string>()
    const collect = (taskId: string): void => {
      evidenceIds.add(taskId)
      for (const child of cut.stateOf<TaskState>(TASK_PROTOCOL, TASK_VERSION, taskId)!.decomposition?.children ?? [])
        collect(child.taskId)
    }
    for (const child of review.children) collect(child.taskId)
    const ownEvidence = [...cut.statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION).values()].find((task) =>
      evidenceIds.has(task.taskId) && task.responsibility !== undefined &&
      cut.stateOf<AgentState>(AGENT_PROTOCOL, AGENT_VERSION, task.responsibility.agentId)?.sessionId === sessionId)
    if (ownEvidence !== undefined) {
      const handle = await apparatus.persistence.open(SessionId(sessionId), 'read')
      try { return (await handle.read(from, count)).events }
      finally { await handle.close() }
    }
    const subject = JSON.parse((await sealedBytes(apparatus, review.subject)).toString('utf8'))
    if (review.target.kind === 'acceptance') {
      const sources: readonly RunSubmission['source'][] = [subject.source,
        ...subject.contributions.flatMap((child: { source?: RunSubmission['source'] }) => child.source === undefined ? [] : [child.source])]
      const source = sources.find((source) => source.sessionId === sessionId)
      if (source === undefined) refuse('not-responsible', 'session is outside the frozen evidence scope')
      const handle = await apparatus.persistence.open(SessionId(source.sessionId), 'read')
      try {
        const events = (await handle.read()).events.slice(0, source.eventCount)
        if (
          events.length !== source.eventCount ||
          digestOf({ sessionId: source.sessionId, eventCount: source.eventCount, events }) !== source.digest
        )
          refuse('digest-mismatch', 'sealed transcript changed')
        sessions = [{ sessionId: source.sessionId, events }]
      } finally {
        await handle.close()
      }
    } else {
      for (const evaluation of subject.evidence)
        for (const trial of evaluation.trials) {
          const { trajectory } = JSON.parse(trial.detail) as { trajectory: FileAttachmentRef }
          const trace = JSON.parse((await sealedBytes(apparatus, trajectory)).toString('utf8'))
          sessions = [...sessions, ...trace.sessions]
        }
    }
  } else {
    const task = [...cut.statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION).values()].findLast(
      (t) => t.responsibility?.agentId === agentId,
    )
    const run = task === undefined ? undefined : Object.values(task.runs).at(-1)
    if (run?.purpose !== 'improve') {
      const { visible } = await readScopeOf(apparatus, agentId, cut)
      const target = [...cut.statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION).values()]
        .find((t) => visible!.has(t.taskId) && t.responsibility !== undefined &&
          cut.stateOf<AgentState>(AGENT_PROTOCOL, AGENT_VERSION, t.responsibility.agentId)?.sessionId === sessionId)
      if (target === undefined) refuse('not-responsible', 'session is outside this task branch and relationship context')
      const handle = await apparatus.persistence.open(SessionId(sessionId), 'read')
      try { return (await handle.read(from, count)).events }
      finally { await handle.close() }
    }
    sessions = JSON.parse((await sealedBytes(apparatus, run.bubble!.inputs[0]!.attachment!)).toString('utf8')).sessions
  }
  const { visible } = await readScopeOf(apparatus, agentId, cut)
  for (const evaluation of cut.statesOf<EvaluationState>(MEASURE_PROTOCOL, MEASURE_VERSION).values())
    for (const trial of evaluation.observed) {
      const result = JSON.parse(trial.detail!) as { taskId: string; trajectory?: FileAttachmentRef }
      if (!visible!.has(result.taskId) || result.trajectory === undefined) continue
      const trace = JSON.parse((await sealedBytes(apparatus, result.trajectory)).toString('utf8'))
      sessions = [...sessions, ...trace.sessions]
    }
  const frozen = sessions.find((s) => s.sessionId === sessionId)
  if (frozen === undefined) refuse('not-responsible', 'session is outside the frozen evidence scope')
  return frozen.events.slice(from, from + count)
}
