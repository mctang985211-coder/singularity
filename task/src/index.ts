/**
 * Event-sourced task store: decomposition tree, dependency DAG, and run state machine.
 * @module dsh-singularity-task
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { SESSION_FORMAT_VERSION, SessionId as makeSessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionHandle } from '@deepseek-ai/dsh-session-persistence'
import type {
  CapabilityManifest,
  DependencyEdge,
  Diagnosis,
  EvidenceBundle,
  Obligation,
  ReviewRecord,
  RunId,
  RunStatus,
  TaskEvent,
  TaskEventKind,
  TaskEventPayloads,
  TaskHandoff,
  TaskId,
  TaskInstance,
  TaskRun,
  TaskSnapshot,
} from './types.ts'
import { runMemberTaskIds } from './types.ts'
import type { DecompositionAdmission } from './contract.ts'
import { ROOT_PROPOSAL_TASK_ID, batchIdFor } from './proposal.ts'
import type {
  TaskProposal,
  TaskProposalConsumption,
  TaskProposalDecisionClaim,
  TaskProposalPhaseChange,
  TaskProposalRootConsumption,
} from './proposal.ts'
import type { TaskBudgetExtensionClaim } from './budget.ts'
import { describeBudgetExtension } from './budget.ts'
import { answerIdOf, questionIdOf, questionOf } from './question.ts'
import type {
  QuestionAnswer,
  QuestionAnswerRecord,
  QuestionAnswerResult,
  QuestionAsk,
  QuestionAskResult,
  QuestionRecord,
} from './question.ts'
import { TaskState } from './service/state.ts'

export * from './types.ts'
export * from './contract.ts'
export * from './budget.ts'
export * from './proposal.ts'
export * from './question.ts'
export { TaskState } from './service/state.ts'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** One task-store mutation in a per-task store; the TaskEvent union that TaskState replays on load. */
    'task/event': TaskEvent
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    task: TaskService
  }
  interface Events {
    'task/change'(snapshot: TaskSnapshot): void
  }
}

type StoredEvent = SessionEvent<'task/event'>

interface TaskStore {
  readonly id: string
  readonly sessionId: SessionId
  state: TaskState
  handle?: SessionHandle
  nextSeq: number
  ready: Promise<void>
  writes: Promise<void>
}

function assertStoreId(id: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error(`task: invalid store id "${id}"`)
}

function now(): string {
  return new Date().toISOString()
}

interface EventInit<K extends TaskEventKind> {
  taskId: TaskId
  runId?: RunId
  sessionId?: string
  parentTaskId?: TaskId
  actor: string
  payload: TaskEventPayloads[K]
}

/**
 * Drop `undefined`-valued keys so an event can enter the session log, which
 * accepts only lossless JSON and rejects `undefined` outright. An optional
 * field carrying `undefined` and an absent optional field mean the same thing
 * here; exotic values are left untouched so the log reports them itself.
 */
function compact<T>(value: T): T {
  if (Array.isArray(value)) return value.map(item => compact(item)) as unknown as T
  if (value === null || typeof value !== 'object') return value
  const prototype: unknown = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return value
  const source = value as Record<string, unknown>
  const target: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(source)) {
    if (item !== undefined) target[key] = compact(item)
  }
  return target as T
}

function event<K extends TaskEventKind>(kind: K, init: EventInit<K>): TaskEvent {
  return {
    kind,
    taskId: init.taskId,
    runId: init.runId,
    sessionId: init.sessionId,
    parentTaskId: init.parentTaskId,
    timestamp: now(),
    actor: init.actor,
    payload: init.payload,
    schemaVersion: 1,
  } as TaskEvent
}

export class TaskService extends Service {
  static inject = ['sessionPersistence']
  private readonly stores = new Map<string, TaskStore>()
  private closing = false

  constructor(ctx: Context) {
    super(ctx, 'task')
    ctx.effect(() => () => this.close(), 'task:persistence')
  }

  async createStore(storeId: string): Promise<TaskSnapshot> {
    if (this.stores.has(storeId)) throw new Error(`task: store "${storeId}" is already open`)
    const store = this.allocate(storeId)
    store.ready = (async () => {
      try {
        const listed = (await this.ctx.sessionPersistence.list()).filter(item => item.header.id === store.sessionId)
        if (listed.length > 0) throw new Error(`task: store "${storeId}" already exists`)
        store.handle = await this.ctx.sessionPersistence.create(this.header(store.sessionId))
      } catch (error) {
        this.stores.delete(storeId)
        throw error
      }
    })()
    await store.ready
    return store.state.snapshot()
  }

  async openStore(storeId: string): Promise<TaskSnapshot> {
    const existing = this.stores.get(storeId)
    if (existing !== undefined) {
      await existing.ready
      return existing.state.snapshot()
    }
    const store = this.allocate(storeId)
    store.ready = this.open(store)
    try {
      await store.ready
    } catch (error) {
      this.stores.delete(storeId)
      throw error
    }
    return store.state.snapshot()
  }

  async snapshotIn(storeId: string): Promise<TaskSnapshot> {
    const store = this.requireStore(storeId)
    await store.ready
    return store.state.snapshot()
  }

  async taskIn(storeId: string, taskId: TaskId): Promise<TaskInstance> {
    const snapshot = await this.snapshotIn(storeId)
    const task = snapshot.tasks.find(item => item.taskId === taskId)
    if (task === undefined) throw new Error(`task: unknown task "${taskId}"`)
    return task
  }

  async runIn(storeId: string, runId: RunId): Promise<TaskRun> {
    const snapshot = await this.snapshotIn(storeId)
    const run = snapshot.runs.find(item => item.runId === runId)
    if (run === undefined) throw new Error(`task: unknown run "${runId}"`)
    return run
  }

  /**
   * The tasks one run has admitted altogether, in the order their batches were
   * admitted ({@link runMemberTaskIds} of the run's own projection) — the run's
   * accumulative membership, which is the sequence a parent criterion's
   * `childIndex` names. Deliberately not the task's children: a task's children
   * are every batch ever admitted under it, while a run's members are the ones
   * *this* run admitted, so a parent that returned to `active` and ran again on
   * a new run has the two answer differently. A run that admitted no batch
   * answers `[]` — its members are not guessed from its task's children.
   */
  async runMembersIn(storeId: string, runId: RunId): Promise<TaskInstance[]> {
    const snapshot = await this.snapshotIn(storeId)
    const run = snapshot.runs.find(item => item.runId === runId)
    if (run === undefined) throw new Error(`task: unknown run "${runId}"`)
    return runMemberTaskIds(run).map(memberTaskId => {
      const task = snapshot.tasks.find(item => item.taskId === memberTaskId)
      if (task === undefined) throw new Error(`task: unknown task "${memberTaskId}"`)
      return task
    })
  }

  async createTaskIn(storeId: string, task: TaskInstance, actor: string): Promise<void> {
    await this.commitIn(storeId, [event('TaskCreated', { taskId: task.taskId, parentTaskId: task.parentTaskId, actor, payload: { task } })])
  }

  async admitTaskIn(
    storeId: string,
    taskId: TaskId,
    actor: string,
    options: { decompositionStatus?: 'leaf' | 'decomposable'; manifest?: CapabilityManifest } = {},
  ): Promise<void> {
    const events: TaskEvent[] = []
    if (options.manifest !== undefined) {
      events.push(event('CapabilityResolved', { taskId, actor, payload: { manifest: options.manifest } }))
      if (options.manifest.missing.length > 0) {
        events.push(event('CapabilityGapDetected', { taskId, actor, payload: { missing: options.manifest.missing } }))
      }
    }
    events.push(event('TaskAdmitted', { taskId, actor, payload: { decompositionStatus: options.decompositionStatus ?? 'leaf' } }))
    await this.commitIn(storeId, events)
  }

  async rejectTaskIn(storeId: string, taskId: TaskId, actor: string, reason: string, manifest?: CapabilityManifest): Promise<void> {
    const events: TaskEvent[] = []
    if (manifest !== undefined) {
      events.push(event('CapabilityResolved', { taskId, actor, payload: { manifest } }))
      if (manifest.missing.length > 0) {
        events.push(event('CapabilityGapDetected', { taskId, actor, payload: { missing: manifest.missing } }))
      }
    }
    events.push(event('TaskRejected', { taskId, actor, payload: { reason } }))
    await this.commitIn(storeId, events)
  }

  /**
   * The atomic batch-admission entry (A3 §1.3): every child's creation and
   * admission, the dependency edges, the parent's decomposition record with the
   * batch identity, the per-child capability manifests and the parent run's
   * `active → waiting_children` phase change land in one commit — a batch is
   * either fully admitted with the gate closed behind it, or not admitted at
   * all. It is the only entry that creates children: a batch that is not a
   * recorded proposal's consumption has no identity, so there is no second
   * "historic" door that admits children without one.
   *
   * `manifests` is aligned with `children` by index (the caller's own batch
   * order): a list of another length is refused before anything is written.
   *
   * `proposal` is the consumption this batch *is* (T2/T3 §6), and it is
   * required: a batch is identified by its parent run and the proposal it
   * consumed, so the batch id is derived from exactly those
   * ({@link batchIdFor}) and a batch that consumed no proposal has no identity
   * to write. The `TaskProposalAdmitted` event joins the same commit, so "this
   * proposal was consumed and these are its tasks" is one durable fact — and
   * the batch identity written on the parent's `TaskDecomposed` event is the
   * same id, so the run's accumulation, the phase change and the consumption
   * name one batch rather than three spellings of it.
   *
   * The consumption must name this parent run and exactly these children in
   * this order — the batch and the record of it are the same batch, checked
   * here because this is the one place that sees both — and the reducer then
   * checks the rest of the binding (digests, derived batch id, the proposal's
   * status, and that no second consumption is written).
   */
  async admitBatchIn(
    storeId: string,
    parentTaskId: TaskId,
    parentRunId: RunId,
    children: readonly TaskInstance[],
    actor: string,
    edges: readonly DependencyEdge[] = [],
    admission?: DecompositionAdmission,
    manifests?: readonly CapabilityManifest[],
    proposal?: TaskProposalConsumption,
  ): Promise<void> {
    if (children.length === 0) throw new Error('task: admit batch requires at least one child')
    if (manifests !== undefined && manifests.length !== children.length) {
      throw new Error(`task: admit batch requires one manifest per child (${children.length} children, ${manifests.length} manifests)`)
    }
    if (proposal === undefined) {
      throw new Error(
        'task: admit batch requires the proposal consumption the batch is; its id is derived from the parent run and the proposal',
      )
    }
    if (proposal.kind === 'root') {
      throw new Error(
        `task: admit batch cannot record the root consumption of proposal "${proposal.proposalId}"; a root contract is activated with admitRootProposalIn`,
      )
    }
    if (proposal.parentRunId !== parentRunId) {
      throw new Error(
        `task: admit batch requires the consumption of proposal "${proposal.proposalId}" to name the parent run it is admitted on ` +
        `(the consumption names "${proposal.parentRunId}", the call admits "${parentRunId}")`,
      )
    }
    if (proposal.childTaskIds.length !== children.length
      || !proposal.childTaskIds.every((childTaskId, index) => childTaskId === children[index]?.taskId)) {
      throw new Error(
        `task: admit batch requires the proposal consumption to name its children in batch order (${children.length} children, ${proposal.childTaskIds.length} consumed)`,
      )
    }
    const batchId = batchIdFor(parentRunId, proposal.proposalId)
    const events: TaskEvent[] = []
    for (const child of children) {
      if (child.parentTaskId !== parentTaskId) throw new Error(`task: child "${child.taskId}" parentTaskId must be "${parentTaskId}"`)
      if (child.decompositionStatus !== 'leaf' && child.decompositionStatus !== 'decomposable') {
        throw new Error(`task: child "${child.taskId}" decomposition status must be "leaf" or "decomposable"`)
      }
      events.push(event('TaskCreated', { taskId: child.taskId, parentTaskId, actor, payload: { task: child } }))
      events.push(event('TaskAdmitted', { taskId: child.taskId, actor, payload: { decompositionStatus: child.decompositionStatus } }))
    }
    for (const edge of edges) {
      events.push(event('DependencyAdded', { taskId: edge.to, actor, payload: { edge } }))
    }
    events.push(event('TaskDecomposed', {
      taskId: parentTaskId,
      actor,
      payload: {
        childTaskIds: children.map(child => child.taskId),
        ...(admission === undefined ? {} : { admission }),
        batchId,
        parentRunId,
        proposalId: proposal.proposalId,
      },
    }))
    if (manifests !== undefined) {
      children.forEach((child, index) => {
        const manifest = manifests[index] as CapabilityManifest
        events.push(event('CapabilityResolved', { taskId: child.taskId, actor, payload: { manifest } }))
        if (manifest.missing.length > 0) {
          events.push(event('CapabilityGapDetected', { taskId: child.taskId, actor, payload: { missing: manifest.missing } }))
        }
      })
    }
    events.push(event('RunPhaseChanged', {
      taskId: parentTaskId,
      runId: parentRunId,
      actor,
      payload: { phase: 'waiting_children', batchId },
    }))
    events.push(event('TaskProposalAdmitted', { taskId: parentTaskId, actor, payload: proposal }))
    await this.commitIn(storeId, events)
  }

  /**
   * The root activation commit (A0 §1.4, §2): the root task, its run and the
   * proposal that asked for them land in **one** commit — a contract is either
   * active with its task, its run and its consumption on record, or the store is
   * untouched. There is no second entry that creates a root task, so this is the
   * only way a root comes to exist, and it always consumes a proposal: the
   * consumption names the minted task id and run id, and the reducer checks that
   * they are the store's one root task and a run born `active` in the proposal's
   * root session, carrying the contract the proposal committed to.
   *
   * Two refusals happen here, before anything is queued, because they are the
   * caller's to get right: a proposal that is not a root contract (children go
   * through `admitBatchIn`), and a consumption that does not name the task and
   * run this call creates. The store's own gate — a store that already holds a
   * root task refuses root intake (§1.6: one intake, one root, and an old
   * graph's root is history) — is re-checked by the reducer inside the commit, so
   * a racing second activation writes nothing even if it passed this read.
   */
  async admitRootProposalIn(
    storeId: string,
    task: TaskInstance,
    run: TaskRun,
    actor: string,
    options: { consumption: TaskProposalRootConsumption; manifest?: CapabilityManifest },
  ): Promise<void> {
    const store = this.requireStore(storeId)
    await store.ready
    await store.writes
    const snapshot = store.state.snapshot()
    const consumption = options.consumption
    const proposal = snapshot.proposals?.byId[consumption.proposalId]
    if (proposal === undefined) throw new Error(`task: unknown proposal "${consumption.proposalId}"`)
    if (proposal.kind !== 'root') {
      throw new Error(`task: proposal "${consumption.proposalId}" is a decomposition proposal; its children are admitted with admitBatchIn`)
    }
    const existing = snapshot.tasks.find(item => item.parentTaskId === undefined)
    if (existing !== undefined) {
      throw new Error(`task: store "${storeId}" already holds root task "${existing.taskId}"; proposal "${consumption.proposalId}" is refused`)
    }
    if (consumption.rootTaskId !== task.taskId || consumption.rootRunId !== run.runId) {
      throw new Error(
        `task: admit root proposal requires the consumption to name the root task and run it creates ` +
        `(the consumption names "${consumption.rootTaskId}"/"${consumption.rootRunId}", the call admits "${task.taskId}"/"${run.runId}")`,
      )
    }
    if (task.decompositionStatus !== 'leaf' && task.decompositionStatus !== 'decomposable') {
      throw new Error(`task: root task "${task.taskId}" decomposition status must be "leaf" or "decomposable"`)
    }
    const events: TaskEvent[] = [
      event('TaskCreated', { taskId: task.taskId, parentTaskId: task.parentTaskId, actor, payload: { task } }),
      event('TaskAdmitted', { taskId: task.taskId, actor, payload: { decompositionStatus: task.decompositionStatus } }),
    ]
    if (options.manifest !== undefined) {
      events.push(event('CapabilityResolved', { taskId: task.taskId, actor, payload: { manifest: options.manifest } }))
      if (options.manifest.missing.length > 0) {
        events.push(event('CapabilityGapDetected', { taskId: task.taskId, actor, payload: { missing: options.manifest.missing } }))
      }
    }
    events.push(event('TaskStarted', { taskId: task.taskId, runId: run.runId, sessionId: run.sessionId, actor, payload: { run } }))
    events.push(event('TaskProposalAdmitted', { taskId: ROOT_PROPOSAL_TASK_ID, actor, payload: consumption }))
    await this.commitIn(storeId, events)
  }

  async addDependencyIn(storeId: string, edge: DependencyEdge, actor: string): Promise<void> {
    await this.commitIn(storeId, [event('DependencyAdded', { taskId: edge.to, actor, payload: { edge } })])
  }

  async startRunIn(storeId: string, run: TaskRun, actor: string): Promise<void> {
    const store = this.requireStore(storeId)
    await store.ready
    await store.writes
    const task = store.state.snapshot().tasks.find(item => item.taskId === run.taskId)
    const events: TaskEvent[] = []
    if (task?.status === 'failed') events.push(event('TaskRetried', { taskId: run.taskId, actor, payload: {} }))
    events.push(event('TaskStarted', { taskId: run.taskId, runId: run.runId, sessionId: run.sessionId, actor, payload: { run } }))
    await this.commitIn(storeId, events)
  }

  async markRunStatusIn(
    storeId: string,
    taskId: TaskId,
    runId: RunId,
    status: RunStatus | 'verifying',
    actor: string,
    options: { reason?: string; finishedAt?: string } = {},
  ): Promise<void> {
    switch (status) {
      case 'blocked':
        await this.commitIn(storeId, [event('TaskBlocked', { taskId, runId, actor, payload: { reason: options.reason } })])
        return
      case 'verifying':
        await this.commitIn(storeId, [event('TaskVerifying', { taskId, runId, actor, payload: {} })])
        return
      case 'verified':
        await this.commitIn(storeId, [event('TaskVerified', { taskId, runId, actor, payload: { finishedAt: options.finishedAt ?? now() } })])
        return
      case 'failed':
        await this.commitIn(storeId, [event('TaskFailed', { taskId, runId, actor, payload: { reason: options.reason, finishedAt: options.finishedAt ?? now() } })])
        return
      case 'cancelled':
        await this.commitIn(storeId, [event('TaskCancelled', { taskId, runId, actor, payload: { reason: options.reason, finishedAt: options.finishedAt ?? now() } })])
        return
      case 'running':
        throw new Error('task: start a run with startRunIn')
      default:
        throw new Error(`task: unknown run status "${String(status)}"`)
    }
  }

  /**
   * Records one coordination-phase change on a run (A3). The reducer is the
   * gate: only `active → waiting_children` and `waiting_children → active`
   * (both carrying the batch id they open or close) and
   * `active|waiting_children → submitted` (carrying the submission) apply, and
   * a refused transition commits nothing. A parent that returned to `active`
   * may admit another batch, so this entry is not once-in-a-life either.
   *
   * The A3 question-id mount points are no longer part of this write shape
   * (A4): what a run waits on comes from the question records, and a payload
   * that carries either field is refused before anything is queued rather than
   * written as a second index that could disagree with them. The reducer still
   * carries them when an old record carries them, so old stores replay
   * unchanged.
   */
  async changeRunPhaseIn(
    storeId: string,
    taskId: TaskId,
    runId: RunId,
    actor: string,
    payload: TaskEventPayloads['RunPhaseChanged'],
  ): Promise<void> {
    if (payload.pendingQuestionIds !== undefined || payload.blockingQuestionIds !== undefined) {
      throw new Error(
        'task: RunPhaseChanged no longer carries pendingQuestionIds/blockingQuestionIds; question blocking is derived from the question facts, ' +
        'and the A3 fields stay readable on records already written',
      )
    }
    await this.commitIn(storeId, [event('RunPhaseChanged', { taskId, runId, actor, payload })])
  }

  /**
   * Records one question a child run asks its direct parent (A4 §F.1), and
   * returns the record — the one this call wrote, or the one already holding
   * this identity.
   *
   * The identity is derived from the asking run and the caller's request key
   * ({@link questionIdOf}), so a repeated request is answered from the store:
   * same content digest and same blocking declaration return the stored record
   * with `created: false` and write nothing at all, while a disagreement in
   * either is refused by name — the store never silently keeps one declaration
   * and reports the other as delivered. The digest covers the question's text;
   * the body itself stays in the asking Session, cited by `questionRef`.
   *
   * The parent is resolved from the child run's task, never accepted from the
   * caller: its direct parent task, and that task's *current* run. The reads
   * here are advisory (the write lock is not held across them) and the reducer
   * is what binds the record, so a parent run that settled in between refuses
   * the ask inside the commit and writes nothing.
   */
  async askParentQuestionIn(storeId: string, ask: QuestionAsk, actor: string): Promise<QuestionAskResult> {
    const store = this.requireStore(storeId)
    await store.ready
    await store.writes
    const snapshot = store.state.snapshot()
    const questionId = questionIdOf({ childRunId: ask.childRunId, requestKey: ask.requestKey })
    const stored = questionOf(snapshot, questionId)
    if (stored !== undefined) {
      if (stored.questionDigest !== ask.questionDigest) {
        throw new Error(
          `task: question request key "${ask.requestKey}" is already bound to question "${questionId}": the stored content digest does not match the one offered`,
        )
      }
      if (stored.blocking !== ask.blocking) {
        throw new Error(
          `task: question request key "${ask.requestKey}" is already bound to question "${questionId}" with a different blocking declaration`,
        )
      }
      return { question: stored, created: false }
    }
    const child = snapshot.runs.find(item => item.runId === ask.childRunId)
    if (child === undefined) throw new Error(`task: unknown run "${ask.childRunId}"`)
    const childTask = snapshot.tasks.find(item => item.taskId === child.taskId)
    if (childTask === undefined) throw new Error(`task: unknown task "${child.taskId}"`)
    if (childTask.parentTaskId === undefined) {
      throw new Error(`task: task "${childTask.taskId}" has no parent task; a root or parentless replay task cannot ask a parent`)
    }
    const parentTask = snapshot.tasks.find(item => item.taskId === childTask.parentTaskId)
    if (parentTask === undefined) throw new Error(`task: unknown parent task "${childTask.parentTaskId}"`)
    const parentRunId = parentTask.runIds[parentTask.runIds.length - 1]
    if (parentRunId === undefined) {
      throw new Error(`task: parent task "${parentTask.taskId}" has no run for a question from task "${childTask.taskId}"`)
    }
    const question: QuestionRecord = { ...ask, questionId, parentRunId, askedAt: now() }
    await this.commitIn(storeId, [
      event('QuestionAsked', {
        taskId: childTask.taskId,
        runId: child.runId,
        sessionId: child.sessionId,
        parentTaskId: parentTask.taskId,
        actor,
        payload: { question },
      }),
    ])
    return { question, created: true }
  }

  /**
   * Records one answer to a still-open question (A4 §F.1), and returns the
   * record — the one this call wrote, or the one already holding this identity.
   *
   * The identity is derived from the question and the caller's request key
   * ({@link answerIdOf}), and the idempotency check runs *before* the openness
   * check on purpose: an answer that resolved its question may be re-delivered
   * after a crash, and such a retry must get its own record back rather than
   * "the question is already resolved". A repeated key with a different digest
   * or a different `resolves` declaration is refused by name.
   *
   * The answering run is named by the caller and the reducer requires it to be
   * the run the question was asked of; the body citation must sit in that run's
   * own Session. Both runs must still be running: a late answer after either
   * settled is refused before anything is applied, so no terminal run is
   * revived and the store leaves no new fact.
   */
  async answerParentQuestionIn(storeId: string, answer: QuestionAnswer, actor: string): Promise<QuestionAnswerResult> {
    const store = this.requireStore(storeId)
    await store.ready
    await store.writes
    const snapshot = store.state.snapshot()
    const question = questionOf(snapshot, answer.questionId)
    if (question === undefined) throw new Error(`task: unknown question "${answer.questionId}"`)
    const answerId = answerIdOf({ questionId: answer.questionId, requestKey: answer.requestKey })
    const stored = (question.answers ?? []).find(item => item.answerId === answerId)
    if (stored !== undefined) {
      if (stored.answerDigest !== answer.answerDigest) {
        throw new Error(
          `task: answer request key "${answer.requestKey}" is already bound to answer "${answerId}": the stored content digest does not match the one offered`,
        )
      }
      if (stored.resolves !== answer.resolves) {
        throw new Error(
          `task: answer request key "${answer.requestKey}" is already bound to answer "${answerId}" with a different resolves declaration`,
        )
      }
      return { answer: stored, created: false }
    }
    const child = snapshot.runs.find(item => item.runId === question.childRunId)
    if (child === undefined) throw new Error(`task: unknown run "${question.childRunId}"`)
    const childTask = snapshot.tasks.find(item => item.taskId === child.taskId)
    if (childTask === undefined) throw new Error(`task: unknown task "${child.taskId}"`)
    const parent = snapshot.runs.find(item => item.runId === answer.parentRunId)
    if (parent === undefined) throw new Error(`task: unknown run "${answer.parentRunId}"`)
    const record: QuestionAnswerRecord = { ...answer, answerId, answeredAt: now() }
    await this.commitIn(storeId, [
      event('QuestionAnswered', {
        taskId: childTask.taskId,
        runId: parent.runId,
        sessionId: parent.sessionId,
        parentTaskId: parent.taskId,
        actor,
        payload: { answer: record },
      }),
    ])
    return { answer: record, created: true }
  }

  /**
   * Records one no-progress marking on an active run (A3). `rounds` is the
   * caller's consecutive count; the reducer records the value it is given.
   */
  async markRunProgressIn(
    storeId: string,
    taskId: TaskId,
    runId: RunId,
    actor: string,
    payload: TaskEventPayloads['RunProgressMarked'],
  ): Promise<void> {
    await this.commitIn(storeId, [event('RunProgressMarked', { taskId, runId, actor, payload })])
  }

  /**
   * Records one proposal submission (T2/T3 §6; root contracts A0 §2). The
   * immutable record, the policy it was born under, the limits in force, the
   * resolution it was reviewed against, and both context fingerprints. The
   * envelope names the proposal's subject — the parent task for a decomposition
   * batch, the reserved root marker for a root contract. The reducer is the gate:
   * a malformed record, a digest that does not describe its content, a duplicate
   * id, a request key already bound to another proposal, a root intake on a store
   * that already holds a root task — each commits nothing.
   */
  async submitProposalIn(storeId: string, proposal: TaskProposal, actor: string): Promise<void> {
    await this.commitIn(storeId, [
      event('TaskProposalSubmitted', {
        taskId: proposal.kind === 'root' ? ROOT_PROPOSAL_TASK_ID : proposal.identity.parentTaskId,
        actor,
        payload: { proposal },
      }),
    ])
  }

  /**
   * Records one review decision (T2/T3 §6), bound to the dossier digest and
   * both context fingerprints the reviewer was shown. An unknown proposal is
   * refused here, before the commit; every binding is checked by the reducer,
   * so a decision that does not name exactly the stored proposal applies
   * nothing.
   */
  async decideProposalIn(storeId: string, claim: TaskProposalDecisionClaim, actor: string): Promise<void> {
    const taskId = await this.proposalEnvelopeTaskIn(storeId, claim.proposalId)
    await this.commitIn(storeId, [event('TaskProposalDecided', { taskId, actor, payload: claim })])
  }

  /**
   * Records one runtime phase change (T2/T3 §6): to `pending_review` when the
   * deployment tightened to `all`, to `ready` when an approval passed its
   * post-approval re-check, to `stale` when that re-check failed. The status
   * table lives in the reducer; a change that is not legal from the proposal's
   * current status applies nothing.
   */
  async changeProposalPhaseIn(storeId: string, change: TaskProposalPhaseChange, actor: string): Promise<void> {
    const taskId = await this.proposalEnvelopeTaskIn(storeId, change.proposalId)
    await this.commitIn(storeId, [event('TaskProposalPhaseChanged', { taskId, actor, payload: change })])
  }

  /**
   * Records one consumption on its own (T2/T3 §6): the batch the proposal
   * became, by child task id and batch id. `admitBatchIn` writes the same event
   * inside the admission commit, which is the path that keeps the children and
   * the record of them one fact; this entry exists for a caller that admitted
   * the batch through another entry and is recording the consumption beside it.
   */
  async consumeProposalIn(storeId: string, consumption: TaskProposalConsumption, actor: string): Promise<void> {
    const taskId = await this.proposalEnvelopeTaskIn(storeId, consumption.proposalId)
    await this.commitIn(storeId, [event('TaskProposalAdmitted', { taskId, actor, payload: consumption })])
  }

  async recordEvidenceIn(storeId: string, evidence: EvidenceBundle, actor: string): Promise<void> {
    await this.commitIn(storeId, [event('EvidenceProduced', { taskId: evidence.taskId, runId: evidence.taskRunId, actor, payload: { evidence } })])
  }

  async recordReviewIn(storeId: string, review: ReviewRecord, actor: string): Promise<void> {
    await this.commitIn(storeId, [event('ReviewRecorded', { taskId: review.taskId, runId: review.runId, actor, payload: { review } })])
  }

  async recordDiagnosisIn(storeId: string, diagnosis: Diagnosis, actor: string): Promise<void> {
    await this.commitIn(storeId, [event('DiagnosisRecorded', { taskId: diagnosis.taskId, actor, payload: { diagnosis } })])
  }

  async recordObligationIn(storeId: string, obligation: Obligation, actor: string): Promise<void> {
    await this.commitIn(storeId, [event('ObligationRecorded', { taskId: obligation.sourceTaskId, actor, payload: { obligation } })])
  }

  /**
   * Records one approved budget extension (K4), or answers a repeat of one the
   * store already holds.
   *
   * The envelope carries the tree's root task and the root session that asked,
   * and the claim carries the raise itself, its whole reading, its identity and
   * the approving channel's reference. The reducer is the gate for every rule —
   * the root-session and root-task binding, the shape of each pair and of the
   * reading, the identity of the content, one key names one extension, and every
   * dimension the claim was read at has to still be the ceiling in force, the
   * ones it raises and the ones it leaves alone.
   *
   * **Where the idempotency read is.** Inside the store's single write queue,
   * with the append it decides: the key is looked up on the state the batch would
   * be applied to, and a request the store already holds — same key, same
   * identity — is answered there and writes nothing. It has to be inside: a check
   * taken before the queue lets two callers that raced the same request both
   * reach the append, and the reducer's own answer to a repeat is to apply
   * nothing *and still be appended*, which would leave one decision written
   * twice in the log. The reducer's check stays as the gate for every other
   * writer (a replay, a hand-written event, an entry that commits directly): this
   * entry short-circuits the append, the reducer refuses a duplicate's content.
   */
  async recordBudgetExtensionIn(storeId: string, rootTaskId: TaskId, claim: TaskBudgetExtensionClaim, actor: string): Promise<void> {
    await this.serialIn(storeId, async state => {
      const stored = state.snapshot().budgetExtensions?.byRequestKey[claim.requestKey]
      if (stored !== undefined) {
        if (stored.requestDigest !== claim.requestDigest) {
          throw new Error(
            `task: budget extension request key "${claim.requestKey}" is already bound to ${describeBudgetExtension(stored)} (identity ${stored.requestDigest}); ` +
            'one key names one request, and different content under it is a new key rather than a second grant',
          )
        }
        return
      }
      await this.appendIn(storeId, state, [
        event('TaskBudgetExtended', {
          taskId: rootTaskId,
          sessionId: claim.requestedBy,
          actor,
          payload: { extension: claim },
        }),
      ])
    })
  }

  async recordHandoffIn(storeId: string, handoff: TaskHandoff, actor: string): Promise<void> {
    await this.commitIn(storeId, [event('HandoffCreated', {
      taskId: handoff.childTaskId,
      runId: handoff.parentRunId,
      parentTaskId: handoff.parentTaskId,
      actor,
      payload: { handoff },
    })])
  }

  /**
   * Runs `work` inside the store's single write queue and answers what it
   * returned. The queue is the store's one serial region: every commit chains
   * onto it, so work scheduled here sees exactly the state the write before it
   * left, and nothing can interleave between the decision it makes and the
   * append it makes. `work` must not call an entry that chains onto the same
   * queue — it would wait for itself.
   */
  private async serialIn<T>(storeId: string, work: (state: TaskState) => Promise<T> | T): Promise<T> {
    const store = this.requireStore(storeId)
    const run = store.writes.then(async () => {
      await store.ready
      return await work(store.state)
    })
    store.writes = run.then(
      () => undefined,
      () => undefined,
    )
    return await run
  }

  /**
   * Applies one batch and appends it to the store's log — the append half of a
   * commit, for work already inside the write queue ({@link serialIn}).
   *
   * The clone is where the reducer's gates run: a batch the state refuses is
   * never appended and the store is left exactly as it was found. Nothing here
   * decides *whether* a batch is worth appending — an event whose reducer
   * applies nothing is still a recorded fact for some kinds — which is why an
   * entry that needs "no second event for a repeat" answers the repeat before
   * calling this, inside the same serial region.
   */
  private async appendIn(storeId: string, state: TaskState, events: readonly TaskEvent[]): Promise<void> {
    const store = this.requireStore(storeId)
    const next = state.clone()
    for (const item of events) next.apply(item)
    const records = events.map((item, index): StoredEvent => ({
      type: 'task/event',
      seq: SessionSeq(store.nextSeq + index),
      time: Date.now(),
      data: compact(item),
      ignorable: true,
    }))
    await store.handle!.append(records)
    store.state = next
    store.nextSeq += records.length
    this.ctx.emit('task/change', store.state.snapshot())
  }

  async commitIn(storeId: string, events: readonly TaskEvent[]): Promise<void> {
    if (events.length === 0) throw new Error('task: cannot commit an empty event batch')
    await this.serialIn(storeId, async state => { await this.appendIn(storeId, state, events) })
  }

  /**
   * The proposal one event names, read from the store before the commit so an
   * unknown proposal is a refusal *before* anything is queued: the reducer would
   * reject the event anyway, and a caller that asked about a proposal the store
   * does not hold deserves to hear it from the entry it called. The value is
   * advisory — the write lock is not held across it — and the reducer's own check
   * is what actually binds the record.
   */
  private async requireProposalIn(storeId: string, proposalId: string): Promise<TaskProposal> {
    const store = this.requireStore(storeId)
    await store.ready
    await store.writes
    const proposal = store.state.snapshot().proposals?.byId[proposalId]
    if (proposal === undefined) throw new Error(`task: unknown proposal "${proposalId}"`)
    return proposal
  }

  /**
   * The task id a proposal's events carry on the envelope: the parent task a
   * decomposition batch belongs to, or the reserved root marker for a root
   * contract, which has no parent to name (A0 §2). The reducer requires exactly
   * this, so a root event cannot hide behind a real task id.
   */
  private async proposalEnvelopeTaskIn(storeId: string, proposalId: string): Promise<TaskId> {
    const proposal = await this.requireProposalIn(storeId, proposalId)
    return proposal.kind === 'root' ? ROOT_PROPOSAL_TASK_ID : proposal.identity.parentTaskId
  }

  private requireStore(storeId: string): TaskStore {
    if (this.closing) throw new Error('task: service is closing')
    assertStoreId(storeId)
    const store = this.stores.get(storeId)
    if (store === undefined) throw new Error(`task: store "${storeId}" is not open`)
    return store
  }

  private allocate(storeId: string): TaskStore {
    if (this.closing) throw new Error('task: service is closing')
    assertStoreId(storeId)
    const store: TaskStore = {
      id: storeId,
      sessionId: makeSessionId(storeId),
      state: new TaskState(storeId),
      nextSeq: 0,
      ready: Promise.resolve(),
      writes: Promise.resolve(),
    }
    this.stores.set(storeId, store)
    return store
  }

  private async open(store: TaskStore): Promise<void> {
    try {
      const listed = (await this.ctx.sessionPersistence.list()).filter(item => item.header.id === store.sessionId)
      if (listed.length === 0) throw new Error(`task: store "${store.id}" does not exist`)
      if (listed.length > 1) throw new Error(`task: duplicate store session "${store.id}"`)
      store.handle = await this.ctx.sessionPersistence.open(store.sessionId, 'write')
      const { events } = await store.handle.read()
      for (const item of events) {
        if (item.type !== 'task/event' || item.ignorable !== true) {
          throw new Error(`task: invalid persisted event at seq ${item.seq}`)
        }
        const next = store.state.clone()
        next.apply((item as StoredEvent).data)
        store.state = next
        store.nextSeq = item.seq + 1
      }
      await store.handle.flush()
    } catch (error) {
      await store.handle?.close()
      throw error
    }
  }

  private async close(): Promise<void> {
    this.closing = true
    const results = await Promise.allSettled(
      [...this.stores.values()].map(async store => {
        await store.ready
        await store.writes
        await store.handle?.close()
      }),
    )
    this.stores.clear()
    for (const result of results) {
      if (result.status === 'rejected') throw result.reason
    }
  }

  private header(storeId: SessionId): SessionHeader {
    return { version: SESSION_FORMAT_VERSION, id: storeId, createdAt: Date.now(), isSeeded: false }
  }
}

export default TaskService
