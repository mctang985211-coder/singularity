/** Event-sourced task store: decomposition tree, dependency DAG, and run state machine. @module dsh-singularity-task */

import { Context, Service } from '@deepseek-ai/cordis'
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
import { runMemberSlots, runMemberTaskIds } from './types.ts'
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
import { EventStoreSet, type ReadOnlyStoreSnapshot } from './service/store.ts'
import { runIn, taskIn } from './service/checks/primitives.ts'

export * from './types.ts'
export { TERMINAL_RUN_STATUSES, isTerminalRunStatus } from './types.ts'
export * from './contract.ts'
export * from './template.ts'
export * from './budget.ts'
export * from './proposal.ts'
export * from './question.ts'
export { TaskState } from './service/state.ts'
export { EventStoreSet } from './service/store.ts'
export type { EventStoreConfig, EventStoreState, ReadOnlyStoreSnapshot, StoreEntry, StoreOpenMode } from './service/store.ts'

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

/** The capability records one admission writes for a task: the resolved manifest, plus a gap event when something is missing. */
function capabilityEvents(taskId: TaskId, actor: string, manifest: CapabilityManifest): TaskEvent[] {
  const events: TaskEvent[] = [event('CapabilityResolved', { taskId, actor, payload: { manifest } })]
  if (manifest.missing.length > 0) {
    events.push(event('CapabilityGapDetected', { taskId, actor, payload: { missing: manifest.missing } }))
  }
  return events
}

export class TaskService extends Service {
  static inject = ['sessionPersistence']
  private readonly stores: EventStoreSet<'task/event', TaskSnapshot, TaskState>

  constructor(ctx: Context) {
    super(ctx, 'task')
    this.stores = new EventStoreSet<'task/event', TaskSnapshot, TaskState>(ctx, {
      namespace: 'task',
      eventType: 'task/event',
      changeEvent: 'task/change',
      createState: storeId => new TaskState(storeId),
    })
    ctx.effect(() => () => this.stores.close(), 'task:persistence')
  }

  async createStore(storeId: string): Promise<TaskSnapshot> {
    return await this.stores.open(storeId, 'create')
  }

  async openStore(storeId: string): Promise<TaskSnapshot> {
    return await this.stores.open(storeId, 'open')
  }

  async snapshotIn(storeId: string): Promise<TaskSnapshot> {
    return await this.stores.snapshot(storeId)
  }

  /** The zero-write read door ({@link EventStoreSet.readOnlySnapshot}): a missing store answers `exists:false`, never a creation. */
  async snapshotReadOnly(storeId: string): Promise<ReadOnlyStoreSnapshot<TaskSnapshot>> {
    return await this.stores.readOnlySnapshot(storeId)
  }

  async taskIn(storeId: string, taskId: TaskId): Promise<TaskInstance> {
    return taskIn(await this.snapshotIn(storeId), taskId)
  }

  async runIn(storeId: string, runId: RunId): Promise<TaskRun> {
    return runIn(await this.snapshotIn(storeId), runId)
  }

  /** The tasks one run has admitted altogether, in the order their batches were admitted ({@link runMemberTaskIds} of the run's own projection) — the run's accumulative membership, which is the sequence a parent criterion's `childIndex` names. */
  async runMembersIn(storeId: string, runId: RunId): Promise<TaskInstance[]> {
    const snapshot = await this.snapshotIn(storeId)
    const run = runIn(snapshot, runId)
    return runMemberTaskIds(run).map(memberTaskId => taskIn(snapshot, memberTaskId))
  }

  /** The tasks one run reads **by position** — the sequence a parent criterion's `childIndex` indexes, with a not-yet-filled slot left `undefined` ({@link runMemberSlots}). */
  async runMemberSlotsIn(storeId: string, runId: RunId): Promise<(TaskInstance | undefined)[]> {
    const snapshot = await this.snapshotIn(storeId)
    const run = runIn(snapshot, runId)
    return runMemberSlots(run).map(taskId => (taskId === undefined ? undefined : taskIn(snapshot, taskId)))
  }

  async createTaskIn(storeId: string, task: TaskInstance, actor: string): Promise<void> {
    await this.commitIn(storeId, [
      event('TaskCreated', { taskId: task.taskId, parentTaskId: task.parentTaskId, actor, payload: { task } }),
    ])
  }

  async admitTaskIn(
    storeId: string,
    taskId: TaskId,
    actor: string,
    options: { decompositionStatus?: 'leaf' | 'decomposable'; manifest?: CapabilityManifest } = {},
  ): Promise<void> {
    const events: TaskEvent[] = []
    if (options.manifest !== undefined) events.push(...capabilityEvents(taskId, actor, options.manifest))
    events.push(
      event('TaskAdmitted', { taskId, actor, payload: { decompositionStatus: options.decompositionStatus ?? 'leaf' } }),
    )
    await this.commitIn(storeId, events)
  }

  async rejectTaskIn(
    storeId: string,
    taskId: TaskId,
    actor: string,
    reason: string,
    manifest?: CapabilityManifest,
  ): Promise<void> {
    const events: TaskEvent[] = []
    if (manifest !== undefined) events.push(...capabilityEvents(taskId, actor, manifest))
    events.push(event('TaskRejected', { taskId, actor, payload: { reason } }))
    await this.commitIn(storeId, events)
  }

  /** The atomic batch-admission entry (A3 §1.3): every child's creation and admission, the dependency edges, the parent's decomposition record with the batch identity, the per-child capability manifests and the parent run's `active → … */
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
      throw new Error(
        `task: admit batch requires one manifest per child (${children.length} children, ${manifests.length} manifests)`,
      )
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
    if (
      proposal.childTaskIds.length !== children.length ||
      !proposal.childTaskIds.every((childTaskId, index) => childTaskId === children[index]?.taskId)
    ) {
      throw new Error(
        `task: admit batch requires the proposal consumption to name its children in batch order (${children.length} children, ${proposal.childTaskIds.length} consumed)`,
      )
    }
    const batchId = batchIdFor(parentRunId, proposal.proposalId)
    const events: TaskEvent[] = []
    for (const child of children) {
      if (child.parentTaskId !== parentTaskId)
        throw new Error(`task: child "${child.taskId}" parentTaskId must be "${parentTaskId}"`)
      if (child.decompositionStatus !== 'leaf' && child.decompositionStatus !== 'decomposable') {
        throw new Error(`task: child "${child.taskId}" decomposition status must be "leaf" or "decomposable"`)
      }
      events.push(event('TaskCreated', { taskId: child.taskId, parentTaskId, actor, payload: { task: child } }))
      events.push(
        event('TaskAdmitted', {
          taskId: child.taskId,
          actor,
          payload: { decompositionStatus: child.decompositionStatus },
        }),
      )
    }
    for (const edge of edges) {
      events.push(event('DependencyAdded', { taskId: edge.to, actor, payload: { edge } }))
    }
    events.push(
      event('TaskDecomposed', {
        taskId: parentTaskId,
        actor,
        payload: {
          childTaskIds: children.map(child => child.taskId),
          ...(admission === undefined ? {} : { admission }),
          batchId,
          parentRunId,
          proposalId: proposal.proposalId,
        },
      }),
    )
    if (manifests !== undefined) {
      children.forEach((child, index) => {
        events.push(...capabilityEvents(child.taskId, actor, manifests[index] as CapabilityManifest))
      })
    }
    events.push(
      event('RunPhaseChanged', {
        taskId: parentTaskId,
        runId: parentRunId,
        actor,
        payload: { phase: 'waiting_children', batchId },
      }),
    )
    events.push(event('TaskProposalAdmitted', { taskId: parentTaskId, actor, payload: proposal }))
    await this.commitIn(storeId, events)
  }

  /** The root activation commit (A0 §1.4, §2): the root task, its run and the proposal that asked for them land in **one** commit — a contract is either active with its task, its run and its consumption on record, or the store is untouched. */
  async admitRootProposalIn(
    storeId: string,
    task: TaskInstance,
    run: TaskRun,
    actor: string,
    options: { consumption: TaskProposalRootConsumption; manifest?: CapabilityManifest; obligations?: readonly Obligation[] },
  ): Promise<void> {
    const snapshot = await this.stores.settledSnapshot(storeId)
    const consumption = options.consumption
    const proposal = snapshot.proposals?.byId[consumption.proposalId]
    if (proposal === undefined) throw new Error(`task: unknown proposal "${consumption.proposalId}"`)
    if (proposal.kind !== 'root') {
      throw new Error(
        `task: proposal "${consumption.proposalId}" is a decomposition proposal; its children are admitted with admitBatchIn`,
      )
    }
    const existing = snapshot.tasks.find(item => item.parentTaskId === undefined)
    if (existing !== undefined) {
      throw new Error(
        `task: store "${storeId}" already holds root task "${existing.taskId}"; proposal "${consumption.proposalId}" is refused`,
      )
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
    if (options.manifest !== undefined) events.push(...capabilityEvents(task.taskId, actor, options.manifest))
    events.push(
      event('TaskStarted', {
        taskId: task.taskId,
        runId: run.runId,
        sessionId: run.sessionId,
        actor,
        payload: { run },
      }),
    )
    for (const obligation of options.obligations ?? []) {
      events.push(event('ObligationRecorded', { taskId: task.taskId, actor, payload: { obligation } }))
    }
    events.push(event('TaskProposalAdmitted', { taskId: ROOT_PROPOSAL_TASK_ID, actor, payload: consumption }))
    await this.commitIn(storeId, events)
  }

  async addDependencyIn(storeId: string, edge: DependencyEdge, actor: string): Promise<void> {
    await this.commitIn(storeId, [event('DependencyAdded', { taskId: edge.to, actor, payload: { edge } })])
  }

  /** One run starts on a task that may run — a first run, or a new attempt at a task that failed (`TaskRetried`, then `TaskStarted`, in one commit). */
  async startRunIn(
    storeId: string,
    run: TaskRun,
    actor: string,
    options: { manifest?: CapabilityManifest } = {},
  ): Promise<void> {
    const snapshot = await this.stores.settledSnapshot(storeId)
    const task = snapshot.tasks.find(item => item.taskId === run.taskId)
    const events: TaskEvent[] = []
    if (task?.status === 'failed') events.push(event('TaskRetried', { taskId: run.taskId, actor, payload: {} }))
    if (options.manifest !== undefined) events.push(...capabilityEvents(run.taskId, actor, options.manifest))
    events.push(
      event('TaskStarted', { taskId: run.taskId, runId: run.runId, sessionId: run.sessionId, actor, payload: { run } }),
    )
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
        await this.commitIn(storeId, [
          event('TaskBlocked', { taskId, runId, actor, payload: { reason: options.reason } }),
        ])
        return
      case 'verifying':
        await this.commitIn(storeId, [event('TaskVerifying', { taskId, runId, actor, payload: {} })])
        return
      case 'verified':
        await this.commitIn(storeId, [
          event('TaskVerified', { taskId, runId, actor, payload: { finishedAt: options.finishedAt ?? now() } }),
        ])
        return
      case 'failed':
        await this.commitIn(storeId, [
          event('TaskFailed', {
            taskId,
            runId,
            actor,
            payload: { reason: options.reason, finishedAt: options.finishedAt ?? now() },
          }),
        ])
        return
      case 'cancelled':
        await this.commitIn(storeId, [
          event('TaskCancelled', {
            taskId,
            runId,
            actor,
            payload: { reason: options.reason, finishedAt: options.finishedAt ?? now() },
          }),
        ])
        return
      case 'running':
        throw new Error('task: start a run with startRunIn')
      default:
        status satisfies never
    }
  }

  /** Records one coordination-phase change on a run (A3). The reducer is the gate: only `active → waiting_children` and `waiting_children → active` (both carrying the batch id they open or close) and `active|waiting_children → submitted` … */
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

  /** Records one question a child run asks its direct parent (A4 §F.1), and returns the record — the one this call wrote, or the one already holding this identity. */
  async askParentQuestionIn(storeId: string, ask: QuestionAsk, actor: string): Promise<QuestionAskResult> {
    const snapshot = await this.stores.settledSnapshot(storeId)
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
      throw new Error(
        `task: task "${childTask.taskId}" has no parent task; a root or parentless replay task cannot ask a parent`,
      )
    }
    const parentTask = snapshot.tasks.find(item => item.taskId === childTask.parentTaskId)
    if (parentTask === undefined) throw new Error(`task: unknown parent task "${childTask.parentTaskId}"`)
    const parentRunId = parentTask.runIds[parentTask.runIds.length - 1]
    if (parentRunId === undefined) {
      throw new Error(
        `task: parent task "${parentTask.taskId}" has no run for a question from task "${childTask.taskId}"`,
      )
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

  /** Records one answer to a still-open question (A4 §F.1), and returns the record — the one this call wrote, or the one already holding this identity. */
  async answerParentQuestionIn(storeId: string, answer: QuestionAnswer, actor: string): Promise<QuestionAnswerResult> {
    const snapshot = await this.stores.settledSnapshot(storeId)
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

  /** Records one no-progress marking on an active run (A3). `rounds` is the caller's consecutive count; the reducer records the value it is given. */
  async markRunProgressIn(
    storeId: string,
    taskId: TaskId,
    runId: RunId,
    actor: string,
    payload: TaskEventPayloads['RunProgressMarked'],
  ): Promise<void> {
    await this.commitIn(storeId, [event('RunProgressMarked', { taskId, runId, actor, payload })])
  }

  /** Records one proposal submission (T2/T3 §6; root contracts A0 §2). The immutable record, the policy it was born under, the limits in force, the resolution it was reviewed against, and both context fingerprints. */
  async submitProposalIn(storeId: string, proposal: TaskProposal, actor: string): Promise<void> {
    await this.commitIn(storeId, [
      event('TaskProposalSubmitted', {
        taskId: proposal.kind === 'root' ? ROOT_PROPOSAL_TASK_ID : proposal.identity.parentTaskId,
        actor,
        payload: { proposal },
      }),
    ])
  }

  /** Records one review decision (T2/T3 §6), bound to the dossier digest and both context fingerprints the reviewer was shown. */
  async decideProposalIn(storeId: string, claim: TaskProposalDecisionClaim, actor: string): Promise<void> {
    const taskId = await this.proposalEnvelopeTaskIn(storeId, claim.proposalId)
    await this.commitIn(storeId, [event('TaskProposalDecided', { taskId, actor, payload: claim })])
  }

  /** Records one runtime phase change (T2/T3 §6): to `pending_review` when the deployment tightened to `all`, to `ready` when an approval passed its post-approval re-check, to `stale` when that re-check failed. */
  async changeProposalPhaseIn(storeId: string, change: TaskProposalPhaseChange, actor: string): Promise<void> {
    const taskId = await this.proposalEnvelopeTaskIn(storeId, change.proposalId)
    await this.commitIn(storeId, [event('TaskProposalPhaseChanged', { taskId, actor, payload: change })])
  }

  /** Records one consumption on its own (T2/T3 §6): the batch the proposal became, by child task id and batch id. */
  async consumeProposalIn(storeId: string, consumption: TaskProposalConsumption, actor: string): Promise<void> {
    const taskId = await this.proposalEnvelopeTaskIn(storeId, consumption.proposalId)
    await this.commitIn(storeId, [event('TaskProposalAdmitted', { taskId, actor, payload: consumption })])
  }

  async recordEvidenceIn(storeId: string, evidence: EvidenceBundle, actor: string): Promise<void> {
    await this.commitIn(storeId, [
      event('EvidenceProduced', { taskId: evidence.taskId, runId: evidence.taskRunId, actor, payload: { evidence } }),
    ])
  }

  async recordReviewIn(storeId: string, review: ReviewRecord, actor: string): Promise<void> {
    await this.commitIn(storeId, [
      event('ReviewRecorded', { taskId: review.taskId, runId: review.runId, actor, payload: { review } }),
    ])
  }

  async recordDiagnosisIn(storeId: string, diagnosis: Diagnosis, actor: string): Promise<void> {
    await this.commitIn(storeId, [
      event('DiagnosisRecorded', { taskId: diagnosis.taskId, actor, payload: { diagnosis } }),
    ])
  }

  async recordObligationIn(storeId: string, obligation: Obligation, actor: string): Promise<void> {
    await this.commitIn(storeId, [
      event('ObligationRecorded', { taskId: obligation.sourceTaskId, actor, payload: { obligation } }),
    ])
  }

  /** Records one approved budget extension (K4), or answers a repeat of one the store already holds. */
  async recordBudgetExtensionIn(
    storeId: string,
    rootTaskId: TaskId,
    claim: TaskBudgetExtensionClaim,
    actor: string,
  ): Promise<void> {
    if (claim.deadlineAt !== undefined || claim.baseline.deadlineAt !== undefined || claim.maxRuns === undefined) {
      throw new Error('task: new budget extensions require maxRuns and accept no deadlineAt')
    }
    await this.stores.serial(storeId, async state => {
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
      await this.stores.append(storeId, state, [
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
    await this.commitIn(storeId, [
      event('HandoffCreated', {
        taskId: handoff.childTaskId,
        runId: handoff.parentRunId,
        parentTaskId: handoff.parentTaskId,
        actor,
        payload: { handoff },
      }),
    ])
  }

  async commitIn(storeId: string, events: readonly TaskEvent[]): Promise<void> {
    await this.stores.commit(storeId, events)
  }

  /** The proposal one event names, read from the store before the commit so an unknown proposal is a refusal *before* anything is queued: the reducer would reject the event anyway, and a caller that asked about a proposal the store does not … */
  private async requireProposalIn(storeId: string, proposalId: string): Promise<TaskProposal> {
    const proposal = (await this.stores.settledSnapshot(storeId)).proposals?.byId[proposalId]
    if (proposal === undefined) throw new Error(`task: unknown proposal "${proposalId}"`)
    return proposal
  }

  /** The task id a proposal's events carry on the envelope: the parent task a decomposition batch belongs to, or the reserved root marker for a root contract, which has no parent to name (A0 §2). */
  private async proposalEnvelopeTaskIn(storeId: string, proposalId: string): Promise<TaskId> {
    const proposal = await this.requireProposalIn(storeId, proposalId)
    return proposal.kind === 'root' ? ROOT_PROPOSAL_TASK_ID : proposal.identity.parentTaskId
  }
}

export default TaskService
