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
import type { DecompositionAdmission } from './contract.ts'
import { TaskState } from './service/state.ts'

export * from './types.ts'
export * from './contract.ts'
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

  async childrenIn(storeId: string, taskId: TaskId): Promise<TaskInstance[]> {
    const snapshot = await this.snapshotIn(storeId)
    const parent = snapshot.tasks.find(item => item.taskId === taskId)
    if (parent === undefined) throw new Error(`task: unknown task "${taskId}"`)
    return parent.childTaskIds.map(childTaskId => snapshot.tasks.find(item => item.taskId === childTaskId) as TaskInstance)
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

  async decomposeIn(
    storeId: string,
    parentTaskId: TaskId,
    children: readonly TaskInstance[],
    actor: string,
    edges: readonly DependencyEdge[] = [],
    admission?: DecompositionAdmission,
  ): Promise<void> {
    if (children.length === 0) throw new Error('task: decompose requires at least one child')
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
      payload: { childTaskIds: children.map(child => child.taskId), ...(admission === undefined ? {} : { admission }) },
    }))
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

  async recordHandoffIn(storeId: string, handoff: TaskHandoff, actor: string): Promise<void> {
    await this.commitIn(storeId, [event('HandoffCreated', {
      taskId: handoff.childTaskId,
      runId: handoff.parentRunId,
      parentTaskId: handoff.parentTaskId,
      actor,
      payload: { handoff },
    })])
  }

  async commitIn(storeId: string, events: readonly TaskEvent[]): Promise<void> {
    if (events.length === 0) throw new Error('task: cannot commit an empty event batch')
    const store = this.requireStore(storeId)
    const run = store.writes.then(async () => {
      await store.ready
      const next = store.state.clone()
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
    })
    store.writes = run.then(
      () => undefined,
      () => undefined,
    )
    await run
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
