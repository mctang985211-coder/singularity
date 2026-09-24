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
import { ROOT_PROPOSAL_TASK_ID } from './proposal.ts'
import type {
  TaskProposal,
  TaskProposalConsumption,
  TaskProposalDecisionClaim,
  TaskProposalPhaseChange,
  TaskProposalRootConsumption,
} from './proposal.ts'
import { TaskState } from './service/state.ts'

export * from './types.ts'
export * from './contract.ts'
export * from './proposal.ts'
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

  /**
   * The atomic batch-admission entry (A3 §1.3): every child's creation and
   * admission, the dependency edges, the parent's decomposition record, the
   * per-child capability manifests and the parent run's
   * `active → waiting_children` phase change land in one commit — a batch is
   * either fully admitted with the gate closed behind it, or not admitted at
   * all. `decomposeIn` stays as the historical entry that leaves the parent
   * run's phase untouched; this is the entry that makes admission atomic.
   *
   * `manifests` is aligned with `children` by index (the caller's own batch
   * order): a list of another length is refused before anything is written.
   *
   * `proposal` consumes the proposal this batch *is* (T2/T3 §6): the
   * `TaskProposalAdmitted` event joins the same commit, so "this proposal was
   * consumed and these are its tasks" is one durable fact. The consumption must
   * name exactly these children in this order — the batch and the record of it
   * are the same batch, checked here because this is the one place that sees
   * both — and the reducer then checks the rest of the binding (digests, batch
   * id, the proposal's status, and that no second consumption is written).
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
    if (proposal?.kind === 'root') {
      throw new Error(
        `task: admit batch cannot record the root consumption of proposal "${proposal.proposalId}"; a root contract is activated with admitRootProposalIn`,
      )
    }
    if (proposal !== undefined
      && (proposal.childTaskIds.length !== children.length
        || !proposal.childTaskIds.every((childTaskId, index) => childTaskId === children[index]?.taskId))) {
      throw new Error(
        `task: admit batch requires the proposal consumption to name its children in batch order (${children.length} children, ${proposal.childTaskIds.length} consumed)`,
      )
    }
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
      payload: { phase: 'waiting_children', batchId: `b-${parentTaskId}` },
    }))
    if (proposal !== undefined) {
      events.push(event('TaskProposalAdmitted', { taskId: parentTaskId, actor, payload: proposal }))
    }
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
   * gate: only `active → waiting_children` (carrying the batch id) and
   * `active|waiting_children → submitted` (carrying the submission) apply, and
   * a refused transition commits nothing.
   */
  async changeRunPhaseIn(
    storeId: string,
    taskId: TaskId,
    runId: RunId,
    actor: string,
    payload: TaskEventPayloads['RunPhaseChanged'],
  ): Promise<void> {
    await this.commitIn(storeId, [event('RunPhaseChanged', { taskId, runId, actor, payload })])
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
