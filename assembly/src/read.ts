import { searchHistory, searchFeedback } from './rsi-history.ts'
import { rsiProposalContract, rsiProposalTemplate, RSI_REPORT_FORMAT, RSI_REPORT_TEMPLATE } from './rsi-proposal.ts'
import { REVIEW_PROTOCOL, REVIEW_VERSION, type ReviewRun } from '../../src/review/protocol.ts'
import { setTimeout } from 'node:timers/promises'
import type { ChildSession } from '../../src/runtime/child-session.ts'
import { childSettled, projectTree, taskRelations, type TreeView } from '../../src/task/tree.ts'
import { refuse } from '../../src/protocol/refusal.ts'
import { AGENT_PROTOCOL, AGENT_VERSION, type AgentState } from '../../src/agent/protocol.ts'
import { ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION, type EnvironmentState } from '../../src/environment/protocol.ts'
import { TASK_PROTOCOL, TASK_VERSION, type RevisionRef, type RunState, type RunSubmission, type TaskState,
} from '../../src/task/protocol.ts'
import type { TaskContract } from '../../src/task/contract.ts'
import { projectReceipt, projectTask, type ReceiptView, type RunView, type TaskView } from '../../src/task/view.ts'
import type { RoundDecision } from '../../src/strategy/view.ts'
import { taskStateOf, type Apparatus } from './apparatus.ts'
import { loadMethod, methodEnvironment, METHOD_FORMAT, type MethodAssets } from './method.ts'
import { consumeMethod, readMethodContext } from './method-run.ts'
import { contractFor } from './inputs.ts'
import type { EvolutionOptions } from './evolution.ts'
import { RELEASE_PROTOCOL, RELEASE_VERSION, type ReleaseState } from '../../src/release/protocol.ts'
import { snapshotOf } from './snapshot.ts'
import { rsiState } from './rsi-state.ts'

import { digestOf } from '../../src/protocol/envelope.ts'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { sealedBytes } from './sealed.ts'
import { MEASURE_PROTOCOL, MEASURE_VERSION, type EvaluationState } from '../../src/measure/protocol.ts'
import { coordinationOf, parentContextOf, parentPlan, waitingReason, readScopeOf } from './coordination.ts'
import type { FrozenInputProducer, FrozenRsiEvidence } from './review.ts'
import { readHistory } from './history.ts'
import { trajectoryPage, textPage } from './pages.ts'

export interface ReadInput {
  readonly kind?: 'summary' | 'workflow' | 'task' | 'artifact' | 'template' | 'method' | 'search' | 'round' | 'subject' | 'trajectory' | 'roots' | 'sessions' | 'usage' | 'steps'
  readonly rootId?: string
  readonly ref?: string
  readonly runId?: string
  readonly eventSeq?: number
  readonly from?: number
  readonly count?: number
  readonly producers?: Readonly<Record<string, unknown>>
}

/** One model-facing read boundary; all projections come from the committed protocols. */
export async function readForAgent(apparatus: Apparatus, agentId: string, input: ReadInput = {},
  evaluation?: Pick<EvolutionOptions, 'criterion' | 'metric' | 'trials' | 'weights' | 'calibration'>,
): Promise<unknown> {
  if (input.kind === 'trajectory') return readTrajectory(apparatus, agentId, input.ref!, input.from, input.count, input.eventSeq, input.rootId)
  if (input.rootId !== undefined || ['roots', 'sessions', 'usage', 'steps'].includes(input.kind ?? ''))
    return readHistory(apparatus, agentId, input)
  const cut = apparatus.store.load(), tasks = cut.statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION)
  const task = [...tasks.values()].findLast((state) => state.responsibility?.agentId === agentId)
  const review = [...cut.statesOf<ReviewRun>(REVIEW_PROTOCOL, REVIEW_VERSION).values()].findLast((state) => state.agentId === agentId)
  const { visible, audit, frozenProducers } = await readScopeOf(apparatus, agentId, cut)
  const run = task === undefined ? undefined : Object.values(task.runs).at(-1)!
  const current = review?.reviewId ?? task!.taskId
  if (input.kind === 'search') {
    if (review !== undefined || run?.purpose !== 'improve' || task?.search === undefined)
      refuse('not-responsible', 'search state belongs to its RSI author')
    const history = searchHistory(apparatus, task)
    const feedback = await searchFeedback(apparatus, task)
    if (input.ref === 'feedback') return textPage(Buffer.from(JSON.stringify(feedback, null, 2)), input.from, input.count)
    if (input.ref === 'authoring') return textPage(Buffer.from(JSON.stringify({
      proposal: rsiProposalContract, method: METHOD_FORMAT, report: RSI_REPORT_FORMAT,
    }, null, 2)), input.from, input.count)
    if (input.ref !== undefined) refuse('malformed-declaration', 'search ref must be authoring or feedback')
    return { ...rsiState(task), reference: history.incumbent, nextRound: history.directives,
      cases: apparatus.domain.suite?.cases.filter(c => c.split === 'evolve').map(c => ({ caseId: c.caseId, familyId: c.familyId })) ?? [],
      feedback: { edits: feedback.edits.map(edit => ({ roundId: edit.roundId, outcome: edit.outcome, revision: edit.revision })),
        rejected: feedback.rejected.map(({ batchId, slot, status }) => ({ batchId, slot, status })) },
      authoring: { proposal: rsiProposalTemplate(), report: structuredClone(RSI_REPORT_TEMPLATE),
        instructions: 'Read kind=search with ref=authoring and from/count for proposal and report rules.',
        assets: 'Read kind=method for the current assets; kind=method with from/count pages its JSON as UTF-8 bytes.',
        feedback: 'Read kind=search with ref=feedback and from/count for full rejection details and measurements.' },
    }
  }
  if (input.kind === 'workflow') {
    if (review !== undefined || audit || task === undefined) refuse('not-responsible', 'workflow metadata belongs to business Tasks')
    const graph = taskRelations(tasks), rootId = graph.rootOf(task.taskId)
    if (input.ref !== undefined && (!tasks.has(input.ref) || graph.rootOf(input.ref) !== rootId))
      refuse('not-responsible', 'workflow is outside this Task root')
    const from = input.from ?? 0, count = input.count ?? 20
    if (!Number.isSafeInteger(from) || from < 0 || !Number.isSafeInteger(count) || count < 1 || count > 100)
      refuse('malformed-declaration', 'workflow range must use a nonnegative offset and 1 to 100 entries')
    const nodes = [...tasks.values()].filter(state => graph.rootOf(state.taskId) === rootId)
    return { cutoff: cut.entries().length, rootId, total: nodes.length, next: from + count < nodes.length ? from + count : null,
      nodes: nodes.slice(from, from + count).map(state => ({ taskId: state.taskId, goal: state.contract!.goal,
        contractDigest: state.contractDigest, parentId: graph.parents.get(state.taskId) ?? null,
        children: state.decomposition?.children.map(({ taskId, supports, dependsOn, maxRuns, requirement }) =>
          ({ taskId, supports, dependsOn, maxRuns, requirement })) ?? [],
        status: Object.values(state.runs).at(-1)?.status ?? 'pending' })) }
  }
  if (input.kind === 'subject') {
    if (review !== undefined)
      return { subjectDigest: review.subjectDigest, ...textPage(await sealedBytes(apparatus, review.subject), input.from, input.count) }
    if (run?.purpose !== 'improve') refuse('not-responsible', 'subject belongs to an RSI or review assignment')
    const subject = run.bubble!.inputs.find(input => input.name === 'subject.json')!
    return { subjectDigest: subject.digest, ...textPage(await sealedBytes(apparatus, subject.attachment!), input.from, input.count) }
  }
  if (input.kind === 'task' || input.kind === 'artifact') {
    const id = input.ref ?? task?.taskId
    if (id === undefined || !visible!.has(id)) refuse('not-responsible', 'Task is outside this evidence scope')
    const producers = frozenProducers.get(id)
    if (producers !== undefined) {
      if (input.kind === 'task') return readFrozenProducer(apparatus, producers)
      if (input.runId === undefined && producers.length !== 1)
        refuse('malformed-declaration', 'multiple frozen producer Runs require an explicit runId')
      const producer = input.runId === undefined ? producers[0] : producers.find((producer) => producer.runId === input.runId)
      if (producer === undefined) refuse('not-responsible', 'Run is outside this frozen input producer scope')
      return readArtifact(apparatus, id, producer.runId, input.from, input.count)
    }
    return input.kind === 'artifact' ? readArtifact(apparatus, id, input.runId, input.from, input.count)
      : readTask(apparatus, taskStateOf(apparatus, id))
  }
  const search = run?.purpose === 'improve' && task?.search !== undefined ? searchHistory(apparatus, task) : undefined
  let reference = review?.method ?? search?.incumbent ?? run!.revision
  if (input.kind === 'method' && input.ref !== undefined && input.ref !== reference.revisionId && input.ref !== reference.digest) {
    if (!audit) refuse('unknown-revision', 'execution methods are pinned to this Run')
    const allowed = [...tasks.values()].filter((state) => visible!.has(state.taskId)).flatMap((state) => {
      const producers = frozenProducers.get(state.taskId)
      return producers === undefined ? [...Object.values(state.runs).map((run) => run.revision),
        ...(state.rounds ?? []).flatMap((round) => [round.incumbent, ...round.candidates])]
        : producers.map((producer) => producer.revision)
    })
    if (review !== undefined && review.target.kind !== 'acceptance') allowed.push({ environmentId: review.target.environmentId,
      revisionId: review.target.revisionId, digest: review.target.assetsDigest })
    reference = allowed.find((ref) => input.ref === ref.revisionId || input.ref === ref.digest)
      ?? refuse('unknown-revision', 'method is outside this frozen evidence scope')
  }
  if (input.kind === 'method' && !audit) return readMethodContext(apparatus, task!.taskId, run!)
  if (input.kind === 'template') {
    const { domain } = await loadMethod(apparatus, reference)
    if (input.ref === undefined) {
      const from = input.from ?? 0, count = input.count ?? 20
      if (!Number.isSafeInteger(from) || from < 0 || !Number.isSafeInteger(count) || count < 1 || count > 100)
        refuse('malformed-declaration', 'template range must use a nonnegative offset and 1 to 100 entries per page')
      return [...domain.templates.values()].slice(from, from + count).map((template) => ({ id: template.id,
        goal: template.goal, ...(template.applicability === undefined ? {} : { applicability: template.applicability }),
        producers: [...new Set(template.inputs.flatMap((input) => input.source.kind === 'artifact' ? [input.source.template] : []))],
      }))
    }
    const selected = domain.templates.get(input.ref)
    if (selected === undefined) refuse('malformed-declaration', 'unknown template ' + input.ref)
    const producers = new Map<string, string>()
    if (input.producers !== undefined) {
      if (input.producers === null || Array.isArray(input.producers) || typeof input.producers !== 'object')
        refuse('malformed-declaration', 'producers must map template IDs to Task IDs or batch keys')
      for (const [template, id] of Object.entries(input.producers)) {
        if (typeof id !== 'string' || !id) refuse('malformed-declaration', 'producer bindings must be nonempty Task IDs or batch keys')
        producers.set(template, id)
      }
    }
    const contract = input.producers === undefined && task?.contract?.template?.id === selected.id &&
      task.contract.template.digest === selected.digest ? task.contract : contractFor(domain, selected, selected.goal, producers)
    if (!audit && selected.guidance !== undefined && run !== undefined)
      await consumeMethod(apparatus, task!.taskId, run, `guidance:${selected.id}`, `read:guidance:${selected.id}:${selected.digest}`)
    return { contract, ...(selected.guidance === undefined ? {} : { guidance: selected.guidance }),
      ...(selected.applicability === undefined ? {} : { applicability: selected.applicability }),
      ...(selected.decomposition === undefined ? {} : { decomposition: selected.decomposition }),
    }
  }
  if (input.kind === 'method') {
    const { assets } = await loadMethod(apparatus, reference)
    if (input.from !== undefined || input.count !== undefined)
      return { reference, ...textPage(Buffer.from(JSON.stringify(assets, null, 2)), input.from, input.count) }
    if (review !== undefined) return { reference, assets }
    const source = run?.purpose === 'improve' ? tasks.get(run.relatedTo!.taskId)!.runs[run.relatedTo!.runId]!.bubble! : undefined
    return { reference, assets, format: METHOD_FORMAT, evaluation,
      ...(source === undefined ? {} : { rootExecutionContext: { model: source.model, tools: source.tools, conditions: source.conditions, inputs: source.inputs } }),
      rootCapabilities: 'Root coordinates, reads evidence, delegates and submits a verified child artifact. Root cannot execute bash, write/edit files, invoke Skills or method Tools. Implementation and integration belong to children. Candidate procedures must respect these roles.',
      costAccounting: 'Compare native token-meter/tokenUsage for one fresh business root, its delegated work and independent acceptance through submission. RSI analysis, proposal, evaluation orchestration and publication review usage never enters any comparison. Candidate cost must be at most 125% of baseline; no quality gain permits no cost increase.',
    }
  }
  if (input.kind === 'round') {
    if (!audit) refuse('not-responsible', 'evaluation results belong to RSI and independent review')
    if (review?.target.kind === 'acceptance') {
      const subject = JSON.parse((await sealedBytes(apparatus, review.subject)).toString('utf8')) as { rsiEvidence?: FrozenRsiEvidence }
      const frozen = subject.rsiEvidence?.rounds.find(round => round.request.roundId === input.ref)
      if (frozen === undefined) refuse('not-responsible', 'round is outside this frozen evidence scope')
      return { ...frozen, publication: null }
    }
    const held = [...tasks.values()].filter((task) => visible!.has(task.taskId) && !frozenProducers.has(task.taskId)).flatMap((task) => task.rounds ?? [])
      .find((round) => round.roundId === input.ref)
    const publication = review?.target.kind === 'publication'
      ? JSON.parse((await sealedBytes(apparatus, review.subject)).toString('utf8')) : undefined
    if (held === undefined && publication?.draft.basis.roundId !== input.ref)
      refuse('not-responsible', 'round is outside this frozen evidence scope')
    const release = cut.stateOf<ReleaseState>(RELEASE_PROTOCOL, RELEASE_VERSION, methodEnvironment(apparatus))
    const published = release?.basis?.kind === 'decision' && release.basis.roundId === input.ref &&
      cut.stateOf<EnvironmentState>(ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION, methodEnvironment(apparatus))?.pointer === release.revisionId
    return { request: held, publication: published ? { revisionId: release.revisionId, approvalId: release.approvalId } : null, snapshot: (await snapshotOf(apparatus)).rounds.find((round) => round.roundId === input.ref),
      evaluations: [...cut.statesOf<EvaluationState>(MEASURE_PROTOCOL, MEASURE_VERSION).values()]
        .filter((state) => state.evaluationId === `${input.ref}:bootstrap:evaluation` ||
          (state.evaluationId.startsWith(`${input.ref}:`) && /^\d+:candidate:evaluation$/.test(state.evaluationId.slice(input.ref!.length + 1)))),
    }
  }
  const from = input.from ?? 0, count = input.count ?? 20
  if (!Number.isSafeInteger(from) || from < 0 || !Number.isSafeInteger(count) || count < 1 || count > 100)
    refuse('malformed-declaration', 'summary range must use a nonnegative offset and 1 to 100 entries')
  const related = [...tasks.values()].filter((state) => visible!.has(state.taskId))
  return { coordination: coordinationOf(apparatus, current), method: reference,
    total: related.length, from, next: from + count < related.length ? from + count : null,
    tasks: related.slice(from, from + count).map((state) => {
      const producers = frozenProducers.get(state.taskId)
      if (producers !== undefined) return { taskId: state.taskId, parentId: null,
        sessionId: producers[0]!.source.sessionId, children: [], runs: producers.map((producer) => ({
          runId: producer.runId, status: producer.status, artifactDigest: producer.artifactDigest })) }
      const run = Object.values(state.runs).at(-1)
      return { taskId: state.taskId,
        parentId: parentPlan(apparatus, state.taskId)?.id ?? null,
        sessionId: cut.stateOf<AgentState>(AGENT_PROTOCOL, AGENT_VERSION, state.responsibility!.agentId)!.sessionId,
        children: state.decomposition?.children.map(({ taskId }) => taskId) ?? [],
        runs: run === undefined ? [] : [{ runId: run.runId, status: run.status, stage: run.stage,
          artifactDigest: run.submission?.artifactDigest }],
      }
    }),
  }
}

export function planOutcomeOf(apparatus: Apparatus, plan: TreeView) {
  const complete = plan.children.every(childSettled)
  if (!complete) return undefined
  const ids = new Set(plan.children.map((c) => c.taskId))
  const fact = apparatus.store.load().entries().findLast((fact) =>
    (ids.has(fact.subject) && (fact.kind === 'run/verified' || fact.kind === 'run/failed')) ||
    (fact.subject === plan.parentTaskId && (fact.kind === 'task/decomposed' || fact.kind === 'review/decomposed' || fact.kind === 'task/explorations-stopped')))
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

export interface ReadRun extends RunView {
  readonly receipt: ReceiptView | null
  readonly artifact: FileAttachmentRef | null
  readonly source: RunSubmission['source'] | null
}
export interface ReadTask extends Omit<TaskView, 'runs' | 'goal'> {
  readonly contract: TaskContract
  readonly agentId: string | null
  readonly sessionId: string | null
  readonly decomposition: TaskState['decomposition'] | null
  readonly runs: readonly ReadRun[]
  readonly parent: NonNullable<ReturnType<typeof parentContextOf>>['parent'] | null
  readonly handoff?: NonNullable<ReturnType<typeof parentContextOf>>['handoff']
  readonly questions: TaskState['questions']
  readonly waiting: string | null
}
export interface MethodHistory {
  readonly tasks: readonly ReadTask[]
  readonly methods: readonly { readonly reference: RevisionRef; readonly assets: MethodAssets }[]
  readonly decisions: readonly RoundDecision[]
}

export async function readTask(apparatus: Apparatus, state: TaskState): Promise<ReadTask> {
  const { goal: _goal, ...view } = projectTask(state)
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
    parent: null, ...parentContextOf(apparatus, state.taskId), questions: state.questions,
    waiting: waitingReason(apparatus, state.taskId) ?? null,
  }
}

/** Verified Run facts are immutable; project only those explicitly sealed into this review. */
async function readFrozenProducer(apparatus: Apparatus, producers: readonly FrozenInputProducer[]): Promise<ReadTask> {
  const state = taskStateOf(apparatus, producers[0]!.taskId)
  const task = await readTask(apparatus, { ...state,
    runs: Object.fromEntries(producers.map((producer) => [producer.runId, state.runs[producer.runId]!])),
  })
  const { handoff: _handoff, ...view } = task
  return { ...view, contract: producers[0]!.contract, phase: 'verified', agentId: null,
    sessionId: producers[0]!.source.sessionId, parent: null, decomposition: null, questions: [], waiting: null,
    runs: task.runs.filter((run) => producers.some((producer) => producer.runId === run.runId)).map((run) => {
      const producer = producers.find((producer) => producer.runId === run.runId)!
      return { ...run, artifact: producer.artifact, source: producer.source, evidence: producer.evidence }
    }),
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
  const { visible, revisions, audit, frozenProducers } = await readScopeOf(apparatus, agentId, committed)
  const tasks = await Promise.all([...states.values()]
    .filter((task) => task.contract !== undefined && (visible === undefined || visible.has(task.taskId))).map((task) => {
      const producers = frozenProducers.get(task.taskId)
      return producers === undefined ? readTask(apparatus, task) : readFrozenProducer(apparatus, producers)
    }),
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
    if (waitingReason(apparatus, taskId) !== undefined || task.search?.batches?.some(batch => !batch.settled) || task.rounds?.some((r) => r.status === 'pending')) {
      await setTimeout(100, undefined, { signal })
      continue
    }
    const answers = (task.questions ?? []).filter((q) => q.runId === run.runId).flatMap((q) => q.answers.map((a) => a.seq))
    const outcomes = (task.rounds ?? []).map((r) => apparatus.store.committedOf(`round-settled:${r.roundId}`)!.seq)
    for (const batch of task.search?.batches ?? [])
      if (batch.settled && !batch.outcomes.some(outcome => outcome.status === 'evaluation-requested'))
        outcomes.push(apparatus.store.committedOf(`rsi/batch-ended:${taskId}:${batch.batchId}`)!.seq)
    if (tree !== undefined) outcomes.push(planOutcomeOf(apparatus, tree)!.seq)
    if (await outcomesAnswered(apparatus, session.sessionId, taskId, answers, 'answer') &&
      await outcomesAnswered(apparatus, session.sessionId, taskId, outcomes)) {
      await apparatus.tasks.forAgent(task.responsibility!.agentId).failRun({
        commandId: `no-submission:${taskId}/${run.runId}`, taskId, runId: run.runId, cause: 'business',
        reason: 'the native agent stopped without submitting after coordination settled' })
      return taskStateOf(apparatus, taskId).runs[run.runId]!
    }
    await setTimeout(100, undefined, { signal })
  }
}

export async function readTrajectory(
  apparatus: Apparatus,
  agentId: string,
  sessionId: string,
  from = 0,
  count?: number,
  eventSeq?: number,
  rootId?: string,
): Promise<unknown> {
  const cut = apparatus.store.load(),
    review = [...cut.statesOf<ReviewRun>(REVIEW_PROTOCOL, REVIEW_VERSION).values()].findLast(
      (r) => r.agentId === agentId,
    )
  const task = [...cut.statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION).values()].findLast(
    (state) => state.responsibility?.agentId === agentId,
  )
  const run = task === undefined ? undefined : Object.values(task.runs).at(-1)
  const evaluationRoot = rootId === undefined ? undefined : cut.stateOf<TaskState>(TASK_PROTOCOL, TASK_VERSION, rootId)
  const ownEvaluation = run?.purpose === 'improve' && evaluationRoot !== undefined &&
    Object.values(evaluationRoot.runs).some(held => held.purpose === 'evaluation' && held.relatedTo?.taskId === task!.taskId &&
      (held.case === undefined || held.case.split === 'evolve'))
  if (rootId !== undefined && review === undefined &&
    (run?.purpose !== 'improve' || run.relatedTo?.taskId !== rootId && !ownEvaluation))
    return readHistory(apparatus, agentId, { kind: 'trajectory', rootId, ref: sessionId, from,
      ...(count === undefined ? {} : { count }), ...(eventSeq === undefined ? {} : { eventSeq }) })
  let sessions: readonly { sessionId: string; events: readonly SessionEvent[] }[] = []
  let searchTask: TaskState | undefined
  if (review !== undefined) {
    const subject = JSON.parse((await sealedBytes(apparatus, review.subject)).toString('utf8'))
    const frozen = review.target.kind === 'acceptance' ? subject.rsiEvidence as FrozenRsiEvidence | undefined : undefined
    const citation = frozen?.citations.find(({ reference, page }) => reference.sessionId === sessionId &&
      reference.eventSeq === eventSeq && (rootId === undefined || reference.rootId === rootId) &&
      from >= page.from && (from < page.next || page.complete && from === page.next))
    if (citation !== undefined) {
      const page = citation.page, selected = textPage(Buffer.from(page.text), from - page.from, count)
      return { ...page, ...selected, from, next: page.from + selected.next,
        totalBytes: page.totalBytes, complete: page.complete && selected.complete }
    }
    if (rootId !== undefined && frozen?.rootId !== rootId)
      refuse('not-responsible', 'rootId is outside the frozen evidence scope')
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
      try { return trajectoryPage((await handle.read()).events, from, count, eventSeq) }
      finally { await handle.close() }
    }
    if (review.target.kind === 'acceptance') {
      const attachments = frozen?.sourceTrace === null || frozen?.sourceTrace === undefined ? [] : [frozen.sourceTrace]
      for (const round of frozen?.rounds ?? []) for (const evaluation of round.evaluations)
        for (const trial of [...evaluation.observed, ...(evaluation.failed ?? [])]) {
          const trajectory = trial.detail === undefined ? undefined : (JSON.parse(trial.detail) as { trajectory?: FileAttachmentRef }).trajectory
          if (trajectory !== undefined) attachments.push(trajectory)
        }
      for (const attachment of attachments) {
        const trace = JSON.parse((await sealedBytes(apparatus, attachment)).toString('utf8'))
        sessions = [...sessions, ...trace.sessions]
      }
      const sealed = sessions.filter(session => session.sessionId === sessionId).sort((a, b) => b.events.length - a.events.length)[0]
      if (sealed !== undefined) return trajectoryPage(sealed.events, from, count, eventSeq)
      const sources: readonly RunSubmission['source'][] = [subject.source,
        ...subject.contributions.flatMap((child: { source?: RunSubmission['source'] }) => child.source === undefined ? [] : [child.source]),
        ...subject.inputProducers.map((producer: FrozenInputProducer) => producer.source)]
      const source = sources.filter((source) => source.sessionId === sessionId).sort((a, b) => b.eventCount - a.eventCount)[0]
      if (source === undefined) refuse('not-responsible', 'session is outside the frozen evidence scope')
      const handle = await apparatus.persistence.open(SessionId(source.sessionId), 'read')
      try {
        const events = (await handle.read()).events.slice(0, source.eventCount)
        if (
          events.length !== source.eventCount ||
          digestOf({ sessionId: source.sessionId, eventCount: source.eventCount, events }) !== source.digest
        )
          refuse('digest-mismatch', 'sealed transcript changed')
        return trajectoryPage(events, from, count, eventSeq)
      } finally {
        await handle.close()
      }
    } else if (review.target.kind === 'publication') {
      for (const evaluation of subject.evidence)
        for (const trial of evaluation.trials) {
          const { trajectory } = JSON.parse(trial.detail) as { trajectory: FileAttachmentRef }
          const trace = JSON.parse((await sealedBytes(apparatus, trajectory)).toString('utf8'))
          sessions = [...sessions, ...trace.sessions]
        }
    }
  } else {
    if (run?.purpose !== 'improve') {
      const { visible } = await readScopeOf(apparatus, agentId, cut)
      const target = [...cut.statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION).values()]
        .find((t) => visible!.has(t.taskId) && t.responsibility !== undefined &&
          cut.stateOf<AgentState>(AGENT_PROTOCOL, AGENT_VERSION, t.responsibility.agentId)?.sessionId === sessionId)
      if (target === undefined) refuse('not-responsible', 'session is outside this task branch and relationship context')
      const handle = await apparatus.persistence.open(SessionId(sessionId), 'read')
      try { return trajectoryPage((await handle.read()).events, from, count, eventSeq) }
      finally { await handle.close() }
    }
    searchTask = task
    const root = taskStateOf(apparatus, run.relatedTo!.taskId)
    if (!ownEvaluation) sessions = JSON.parse((await sealedBytes(apparatus, root.rsi!.trace!)).toString('utf8')).sessions
  }
  const roundIds = new Set(searchTask?.rounds?.map(round => round.roundId))
  for (const evaluation of cut.statesOf<EvaluationState>(MEASURE_PROTOCOL, MEASURE_VERSION).values()) {
    if (evaluation.matrix !== undefined && evaluation.matrix.split !== 'evolve' || ![...roundIds].some(id =>
      evaluation.evaluationId === `${id}:bootstrap:evaluation` || evaluation.evaluationId.startsWith(`${id}:`) &&
      /^\d+:candidate:evaluation$/.test(evaluation.evaluationId.slice(id.length + 1)))) continue
    for (const trial of [...evaluation.observed, ...(evaluation.failed ?? [])]) {
      const result = trial.detail === undefined ? undefined : JSON.parse(trial.detail) as { taskId: string; trajectory?: FileAttachmentRef }
      if (result?.trajectory === undefined || ownEvaluation && result.taskId !== rootId) continue
      const trace = JSON.parse((await sealedBytes(apparatus, result.trajectory)).toString('utf8'))
      sessions = [...sessions, ...trace.sessions]
    }
  }
  const frozen = sessions.find((s) => s.sessionId === sessionId)
  if (frozen === undefined) refuse('not-responsible', 'session is outside the frozen evidence scope')
  return trajectoryPage(frozen.events, from, count, eventSeq)
}
