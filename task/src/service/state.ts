/** The task store's reducer: one state owner replaying TaskEvent records, with its lifecycle handlers. @module @dangosys/dsh-singularity-task/service/state */

import type { TaskBudgetExtensionClaim } from '../budget.ts'
import { batchIdFor } from '../proposal.ts'
import { reaches } from '../types.ts'
import type {
  DependencyEdge,
  ExecutionPhase,
  RunId,
  RunStatus,
  TaskEvent,
  TaskEventPayloads,
  TaskId,
  TaskInstance,
  TaskRun,
  TaskSnapshot,
  TaskStatus,
} from '../types.ts'
import { buildBudgetExtension, budgetExtensionIndex } from './checks/budget.ts'
import { assertAdmission, assertContract } from './checks/contract.ts'
import {
  assertBirthPhase,
  assertEnvironmentRevision,
  assertProviderBinding,
  assertQuestionIds,
  assertRunRecovery,
  assertSubmissionShape,
} from './checks/runs.ts'
import { copy, nonEmpty, runIn, taskIn } from './checks/primitives.ts'
import { answerQuestion, askQuestion } from './questions.ts'
import {
  addHandoff,
  produceEvidence,
  recordDiagnosis,
  recordObligation,
  recordReview,
  resolveCapabilities,
} from './records.ts'
import { admitProposal, changeProposalPhase, decideProposal, submitProposal } from './proposals.ts'

const ADMITTED_OR_LATER: readonly TaskStatus[] = ['admitted', 'ready', 'running', 'verifying', 'verified', 'failed']

const EXECUTION_PHASES: readonly ExecutionPhase[] = ['active', 'waiting_children', 'submitted']

/** The batch identity one decomposition event carries, or `undefined` for a record written before batches had one. */
export function assertBatchIdentity(
  snapshot: TaskSnapshot,
  taskId: TaskId,
  payload: TaskEventPayloads['TaskDecomposed'],
): { batchId: string; parentRunId: RunId; proposalId: string } | undefined {
  const { batchId, parentRunId, proposalId } = payload
  if (batchId === undefined && parentRunId === undefined && proposalId === undefined) return undefined
  if (!nonEmpty(batchId) || !nonEmpty(parentRunId) || !nonEmpty(proposalId)) {
    throw new Error(
      `task: task "${taskId}" decomposition batch requires a batch id, a parent run and a proposal; a batch is identified by all three or by none`,
    )
  }
  const run = runIn(snapshot, parentRunId)
  if (run.taskId !== taskId) {
    throw new Error(`task: run "${parentRunId}" belongs to task "${run.taskId}", not "${taskId}"`)
  }
  if ((run.batches ?? []).some(batch => batch.batchId === batchId)) {
    throw new Error(`task: run "${parentRunId}" already holds batch "${batchId}"; one batch identity names one batch`)
  }
  const derived = batchIdFor(parentRunId, proposalId)
  if (batchId !== derived) {
    throw new Error(
      `task: task "${taskId}" decomposition batch "${batchId}" is not the batch of run "${parentRunId}" and proposal "${proposalId}" ("${derived}")`,
    )
  }
  return { batchId, parentRunId, proposalId }
}

export function addTask(snapshot: TaskSnapshot, task: TaskInstance): TaskSnapshot {
  if (typeof task.taskId !== 'string' || task.taskId.length === 0)
    throw new Error('task: task id must be a non-empty string')
  if (typeof task.objective !== 'string' || task.objective.length === 0)
    throw new Error(`task: task "${task.taskId}" objective must be non-empty`)
  if (snapshot.tasks.some(item => item.taskId === task.taskId))
    throw new Error(`task: task "${task.taskId}" already exists`)
  if (task.status !== 'created') throw new Error(`task: task "${task.taskId}" must be created in status "created"`)
  if (task.runIds.length !== 0 || task.childTaskIds.length !== 0)
    throw new Error('task: task runs and children must use events')
  if (task.parentTaskId === task.taskId) throw new Error(`task: task "${task.taskId}" cannot be its own parent`)
  if (task.contract !== undefined) assertContract(task.taskId, task.contract, task)
  if (task.parentTaskId === undefined) {
    if (task.depth !== 0) throw new Error(`task: root task "${task.taskId}" depth must be 0`)
    snapshot = { ...snapshot, tasks: [...snapshot.tasks, copy(task)] }
    return snapshot
  }
  const parent = taskIn(snapshot, task.parentTaskId)
  if (task.depth !== parent.depth + 1) throw new Error(`task: task "${task.taskId}" depth must be parent depth + 1`)
  snapshot = {
    ...snapshot,
    tasks: [
      ...snapshot.tasks.map(item =>
        item.taskId === parent.taskId ? { ...item, childTaskIds: [...item.childTaskIds, task.taskId] } : item,
      ),
      copy(task),
    ],
  }
  return snapshot
}

export function admit(
  snapshot: TaskSnapshot,
  taskId: TaskId,
  decompositionStatus: 'leaf' | 'decomposable',
): TaskSnapshot {
  assertTransition(snapshot, taskId, ['created'], 'admitted')
  snapshot = updateTask(snapshot, taskId, { status: 'admitted', decompositionStatus })
  return snapshot
}

/** A decomposition records the members one batch contributed to the parent: the children are already under it (`TaskCreated`), and this event says they were admitted together, as one batch, by one run. */
export function decompose(
  snapshot: TaskSnapshot,
  taskId: TaskId,
  payload: TaskEventPayloads['TaskDecomposed'],
): TaskSnapshot {
  const parent = taskIn(snapshot, taskId)
  for (const childTaskId of payload.childTaskIds) {
    if (!parent.childTaskIds.includes(childTaskId))
      throw new Error(`task: task "${childTaskId}" is not a child of "${taskId}"`)
  }
  if (
    payload.childTaskIds.length === 0 ||
    payload.childTaskIds.some(childTaskId => !ADMITTED_OR_LATER.includes(taskIn(snapshot, childTaskId).status))
  ) {
    throw new Error(`task: task "${taskId}" cannot decompose without an admitted child`)
  }
  if (payload.admission !== undefined) assertAdmission(taskId, payload.admission)
  const batch = assertBatchIdentity(snapshot, taskId, payload)
  snapshot = updateTask(snapshot, taskId, { decompositionStatus: 'decomposed' })
  if (batch === undefined) return snapshot
  snapshot = {
    ...snapshot,
    runs: snapshot.runs.map(item =>
      item.runId === batch.parentRunId
        ? {
            ...item,
            batches: [
              ...(item.batches ?? []),
              {
                batchId: batch.batchId,
                proposalId: batch.proposalId,
                memberTaskIds: [...payload.childTaskIds],
              },
            ],
          }
        : item,
    ),
  }
  return snapshot
}

export function addDependency(snapshot: TaskSnapshot, edge: DependencyEdge): TaskSnapshot {
  taskIn(snapshot, edge.from)
  taskIn(snapshot, edge.to)
  if (edge.from === edge.to || reaches(snapshot.edges, edge.to, edge.from)) {
    throw new Error(`task: dependency "${edge.from}" → "${edge.to}" creates a cycle`)
  }
  if (snapshot.edges.some(item => item.from === edge.from && item.to === edge.to)) {
    throw new Error(`task: dependency "${edge.from}" → "${edge.to}" already exists`)
  }
  snapshot = { ...snapshot, edges: [...snapshot.edges, copy(edge)] }
  return snapshot
}

export function start(
  snapshot: TaskSnapshot,
  taskId: TaskId,
  envelopeRunId: RunId | undefined,
  run: TaskRun,
): TaskSnapshot {
  if (typeof run.runId !== 'string' || run.runId.length === 0)
    throw new Error('task: run id must be a non-empty string')
  if (snapshot.runs.some(item => item.runId === run.runId)) throw new Error(`task: run "${run.runId}" already exists`)
  if (run.taskId !== taskId) throw new Error(`task: run "${run.runId}" does not belong to task "${taskId}"`)
  if (envelopeRunId !== run.runId) throw new Error(`task: run "${run.runId}" envelope run id mismatch`)
  if (run.status !== 'running') throw new Error(`task: run "${run.runId}" must start in status "running"`)
  if (typeof run.sessionId !== 'string' || run.sessionId.length === 0)
    throw new Error(`task: run "${run.runId}" session id must be non-empty`)
  if (run.providerBinding !== undefined) assertProviderBinding(run.runId, run.providerBinding)
  assertEnvironmentRevision(run.runId, run)
  if (run.recovery !== undefined) assertRunRecovery(snapshot, taskId, run.recovery)
  assertBirthPhase(run)
  if (run.parentRunId !== undefined) runIn(snapshot, run.parentRunId)
  // An improvement round is the one attempt that starts from `verified` (A7 §3/§4).
  const from: TaskStatus[] =
    run.recovery?.kind === 'improvement' ? ['admitted', 'ready', 'verified'] : ['admitted', 'ready']
  assertTransition(snapshot, taskId, from, 'running')
  snapshot = { ...snapshot, runs: [...snapshot.runs, copy(run)] }
  snapshot = updateTask(snapshot, taskId, {
    status: 'running',
    runIds: [...taskIn(snapshot, taskId).runIds, run.runId],
  })
  return snapshot
}

export function block(snapshot: TaskSnapshot, taskId: TaskId, runId: RunId | undefined): TaskSnapshot {
  assertTransition(snapshot, taskId, ['admitted', 'ready', 'running'], 'blocked')
  if (runId !== undefined) assertRunTransition(snapshot, runId, ['running'], 'blocked')
  snapshot = updateTask(snapshot, taskId, { status: 'blocked' })
  if (runId !== undefined) snapshot = setRun(snapshot, runId, 'blocked')
  return snapshot
}

export function verify(
  snapshot: TaskSnapshot,
  taskId: TaskId,
  runId: RunId | undefined,
  finishedAt: string | undefined,
): TaskSnapshot {
  if (runId === undefined) throw new Error(`task: TaskVerified for "${taskId}" requires a run id`)
  assertTransition(snapshot, taskId, ['verifying'], 'verified')
  if (!snapshot.evidence.some(item => item.taskId === taskId && item.taskRunId === runId)) {
    throw new Error(`task: run "${runId}" has no evidence`)
  }
  assertRunTransition(snapshot, runId, ['running'], 'verified')
  snapshot = updateTask(snapshot, taskId, { status: 'verified' })
  snapshot = setRun(snapshot, runId, 'verified', finishedAt)
  return snapshot
}

export function fail(
  snapshot: TaskSnapshot,
  taskId: TaskId,
  runId: RunId | undefined,
  finishedAt: string | undefined,
): TaskSnapshot {
  assertTransition(snapshot, taskId, ['running', 'verifying'], 'failed')
  if (runId !== undefined) assertRunTransition(snapshot, runId, ['running', 'blocked'], 'failed')
  snapshot = updateTask(snapshot, taskId, { status: 'failed' })
  if (runId !== undefined) snapshot = setRun(snapshot, runId, 'failed', finishedAt)
  return snapshot
}

/** A run keeps `running` through verification (the coordination phase, not the status, is what records the submission), so a cancellation that lands while a verifier call is in flight arrives at a task that is already `verifying`. */
export function cancel(
  snapshot: TaskSnapshot,
  taskId: TaskId,
  runId: RunId | undefined,
  finishedAt: string | undefined,
): TaskSnapshot {
  assertTransition(snapshot, taskId, ['running', 'verifying'], 'cancelled')
  if (runId !== undefined) assertRunTransition(snapshot, runId, ['running', 'blocked'], 'cancelled')
  snapshot = updateTask(snapshot, taskId, { status: 'cancelled' })
  if (runId !== undefined) snapshot = setRun(snapshot, runId, 'cancelled', finishedAt)
  return snapshot
}

/** The coordination phase is the A3 admission gate, so this handler is where a transition is either one of the four legal edges or a refusal: a run accepts `active → waiting_children`, `waiting_children → active`, `active → submitted` and … */
export function changeRunPhase(
  snapshot: TaskSnapshot,
  taskId: TaskId,
  runId: RunId | undefined,
  payload: TaskEventPayloads['RunPhaseChanged'],
): TaskSnapshot {
  if (runId === undefined) throw new Error(`task: RunPhaseChanged for task "${taskId}" requires a run id`)
  const run = runIn(snapshot, runId)
  if (run.taskId !== taskId) throw new Error(`task: run "${runId}" belongs to task "${run.taskId}", not "${taskId}"`)
  if (run.status !== 'running') {
    throw new Error(`task: run "${runId}" is ${run.status}; a phase change requires a running run`)
  }
  const to = payload.phase
  if (!EXECUTION_PHASES.includes(to)) {
    throw new Error(`task: run "${runId}" execution phase must be one of ${EXECUTION_PHASES.join(', ')}`)
  }
  const from = run.executionPhase
  if (from === undefined) {
    throw new Error(`task: run "${runId}" has no execution phase; only an active run changes phase`)
  }
  const legal =
    (from === 'active' && (to === 'waiting_children' || to === 'submitted')) ||
    (from === 'waiting_children' && (to === 'active' || to === 'submitted'))
  if (!legal) throw new Error(`task: illegal run phase transition "${from}" → "${to}" for run "${runId}"`)
  if (to === 'waiting_children' || to === 'active') {
    if (!nonEmpty(payload.batchId)) {
      throw new Error(
        to === 'waiting_children'
          ? `task: run "${runId}" entering waiting_children requires a batch id`
          : `task: run "${runId}" returning to active requires the batch id it closes`,
      )
    }
    if (payload.submission !== undefined) {
      throw new Error(`task: run "${runId}" is entering ${to}; only the submitted phase carries a submission`)
    }
  } else {
    if (payload.submission === undefined)
      throw new Error(`task: run "${runId}" submitting requires a submission record`)
    assertSubmissionShape(runId, payload.submission)
    if (payload.batchId !== undefined) {
      throw new Error(
        `task: run "${runId}" is submitting; a batch id belongs to the batch edges, not the submitted phase`,
      )
    }
  }
  assertQuestionIds(runId, payload)
  snapshot = {
    ...snapshot,
    runs: snapshot.runs.map(item => {
      if (item.runId !== runId) return item
      const next: TaskRun = {
        ...item,
        executionPhase: to,
        ...(payload.batchId === undefined ? {} : { batchId: payload.batchId }),
        ...(payload.submission === undefined ? {} : { submission: copy(payload.submission) }),
        ...(payload.pendingQuestionIds === undefined ? {} : { pendingQuestionIds: [...payload.pendingQuestionIds] }),
        ...(payload.blockingQuestionIds === undefined ? {} : { blockingQuestionIds: [...payload.blockingQuestionIds] }),
      }
      // The batch is closed: the run's current batch id is what it is waiting
      // on, and it is waiting on nothing. `batches` keeps the history.
      if (to === 'active') delete next.batchId
      return next
    }),
  }
  return snapshot
}

/** A no-progress marking is the A3 signal a reader shows before the budget stops a stuck run, and it is meaningful only on the phase that can still submit: `active`. */
export function markRunProgress(
  snapshot: TaskSnapshot,
  taskId: TaskId,
  runId: RunId | undefined,
  payload: TaskEventPayloads['RunProgressMarked'],
  timestamp: string,
): TaskSnapshot {
  if (runId === undefined) throw new Error(`task: RunProgressMarked for task "${taskId}" requires a run id`)
  const run = runIn(snapshot, runId)
  if (run.taskId !== taskId) throw new Error(`task: run "${runId}" belongs to task "${run.taskId}", not "${taskId}"`)
  if (run.status !== 'running') {
    throw new Error(`task: run "${runId}" is ${run.status}; progress can only be marked while the run is running`)
  }
  const phase = run.executionPhase
  if (phase !== 'active') {
    throw new Error(
      `task: run "${runId}" execution phase is ${phase === undefined ? 'absent' : `"${phase}"`}; progress is only marked on an active run`,
    )
  }
  if (payload.kind !== 'unsubmitted-idle') {
    throw new Error(`task: run "${runId}" progress kind must be "unsubmitted-idle"`)
  }
  if (!Number.isInteger(payload.rounds) || payload.rounds < 1) {
    throw new Error(`task: run "${runId}" progress rounds must be a positive integer`)
  }
  if (!Number.isInteger(payload.factCount) || payload.factCount < 0) {
    throw new Error(`task: run "${runId}" progress fact count must be a non-negative integer`)
  }
  if (!nonEmpty(payload.note)) throw new Error(`task: run "${runId}" progress requires a note`)
  snapshot = {
    ...snapshot,
    runs: snapshot.runs.map(item =>
      item.runId === runId
        ? {
            ...item,
            noProgress: {
              kind: payload.kind,
              rounds: payload.rounds,
              factCount: payload.factCount,
              markedAt: timestamp,
            },
          }
        : item,
    ),
  }
  return snapshot
}

/** A person raised one of the tree's own ceilings (K4). The reducer is the shape gate, the identity gate and — the part that matters — the *chain* gate, in that order, and it applies nothing at all when any of them refuses. */

export function transit(
  snapshot: TaskSnapshot,
  taskId: TaskId,
  from: readonly TaskStatus[],
  to: TaskStatus,
): TaskSnapshot {
  assertTransition(snapshot, taskId, from, to)
  snapshot = updateTask(snapshot, taskId, { status: to })
  return snapshot
}

export function assertTransition(
  snapshot: TaskSnapshot,
  taskId: TaskId,
  from: readonly TaskStatus[],
  to: TaskStatus,
): void {
  const current = taskIn(snapshot, taskId)
  if (!from.includes(current.status)) {
    throw new Error(`task: illegal transition "${current.status}" → "${to}" for task "${taskId}"`)
  }
}

export function assertRunTransition(
  snapshot: TaskSnapshot,
  runId: RunId,
  from: readonly RunStatus[],
  to: RunStatus,
): void {
  const current = runIn(snapshot, runId)
  if (!from.includes(current.status)) {
    throw new Error(`task: illegal run transition "${current.status}" → "${to}" for run "${runId}"`)
  }
}

export function setRun(snapshot: TaskSnapshot, runId: RunId, status: RunStatus, finishedAt?: string): TaskSnapshot {
  snapshot = {
    ...snapshot,
    runs: snapshot.runs.map(item =>
      item.runId === runId ? { ...item, status, ...(finishedAt !== undefined ? { finishedAt } : {}) } : item,
    ),
  }
  return snapshot
}

export function updateTask(snapshot: TaskSnapshot, taskId: TaskId, patch: Partial<TaskInstance>): TaskSnapshot {
  snapshot = {
    ...snapshot,
    tasks: snapshot.tasks.map(item => (item.taskId === taskId ? { ...item, ...patch } : item)),
  }
  return snapshot
}

/** Applies one approved budget extension to the index: an idempotent repeat is answered from the record and writes nothing. */
export function extendBudget(
  snapshot: TaskSnapshot,
  taskId: TaskId,
  sessionId: string | undefined,
  claim: TaskBudgetExtensionClaim,
  timestamp: string,
): TaskSnapshot {
  const extension = buildBudgetExtension(snapshot, taskId, sessionId, claim, timestamp)
  if (extension === undefined) return snapshot
  const index = budgetExtensionIndex(snapshot)
  return {
    ...snapshot,
    budgetExtensions: {
      all: [...index.all, extension],
      byRequestKey: { ...index.byRequestKey, [extension.requestKey]: extension },
    },
  }
}

export class TaskState {
  private value: TaskSnapshot

  constructor(id: string, snapshot?: TaskSnapshot) {
    this.value = snapshot === undefined ? emptySnapshot(id) : copy(snapshot)
  }

  clone(): TaskState {
    return new TaskState(this.value.id, this.value)
  }

  snapshot(): TaskSnapshot {
    return copy(this.value)
  }

  apply(event: TaskEvent): void {
    switch (event.kind) {
      case 'TaskCreated':
        this.value = addTask(this.value, event.payload.task)
        return
      case 'TaskAdmitted':
        this.value = admit(this.value, event.taskId, event.payload.decompositionStatus)
        return
      case 'TaskRejected':
        this.value = transit(this.value, event.taskId, ['created'], 'blocked')
        return
      case 'TaskDecomposed':
        this.value = decompose(this.value, event.taskId, event.payload)
        return
      case 'DependencyAdded':
        this.value = addDependency(this.value, event.payload.edge)
        return
      case 'TaskStarted':
        this.value = start(this.value, event.taskId, event.runId, event.payload.run)
        return
      case 'TaskBlocked':
        this.value = block(this.value, event.taskId, event.runId)
        return
      case 'TaskVerifying':
        this.value = transit(this.value, event.taskId, ['running'], 'verifying')
        return
      case 'TaskVerified':
        this.value = verify(this.value, event.taskId, event.runId, event.payload.finishedAt)
        return
      case 'TaskFailed':
        this.value = fail(this.value, event.taskId, event.runId, event.payload.finishedAt)
        return
      case 'TaskCancelled':
        this.value = cancel(this.value, event.taskId, event.runId, event.payload.finishedAt)
        return
      case 'TaskRetried':
        this.value = transit(this.value, event.taskId, ['failed'], 'ready')
        return
      case 'RunPhaseChanged':
        this.value = changeRunPhase(this.value, event.taskId, event.runId, event.payload)
        return
      case 'RunProgressMarked':
        this.value = markRunProgress(this.value, event.taskId, event.runId, event.payload, event.timestamp)
        return
      case 'QuestionAsked':
        this.value = askQuestion(this.value, event.taskId, event.runId, event.parentTaskId, event.payload.question)
        return
      case 'QuestionAnswered':
        this.value = answerQuestion(this.value, event.taskId, event.runId, event.parentTaskId, event.payload.answer)
        return
      case 'CapabilityResolved':
        this.value = resolveCapabilities(this.value, event.taskId, event.payload.manifest)
        return
      case 'CapabilityGapDetected':
        taskIn(this.value, event.taskId)
        return
      case 'EvidenceProduced':
        this.value = produceEvidence(this.value, event.taskId, event.runId, event.payload.evidence)
        return
      case 'HandoffCreated':
        this.value = addHandoff(this.value, event.payload.handoff)
        return
      case 'ReviewRecorded':
        this.value = recordReview(this.value, event.taskId, event.runId, event.payload.review)
        return
      case 'DiagnosisRecorded':
        this.value = recordDiagnosis(this.value, event.taskId, event.payload.diagnosis)
        return
      case 'ObligationRecorded':
        this.value = recordObligation(this.value, event.payload.obligation)
        return
      case 'TaskBudgetExtended':
        this.value = extendBudget(this.value, event.taskId, event.sessionId, event.payload.extension, event.timestamp)
        return
      case 'TaskProposalSubmitted':
        this.value = submitProposal(this.value, event.taskId, event.payload.proposal)
        return
      case 'TaskProposalDecided':
        this.value = decideProposal(this.value, event.taskId, event.payload, event.timestamp)
        return
      case 'TaskProposalPhaseChanged':
        this.value = changeProposalPhase(this.value, event.taskId, event.payload, event.timestamp)
        return
      case 'TaskProposalAdmitted':
        this.value = admitProposal(this.value, event.taskId, event.payload, event.timestamp)
        return
      default:
        throw new Error(`task: unknown event kind "${(event as { kind?: unknown }).kind}"`)
    }
  }
}

function emptySnapshot(id: string): TaskSnapshot {
  return {
    version: 1,
    id,
    tasks: [],
    runs: [],
    edges: [],
    evidence: [],
    handoffs: [],
    reviews: [],
    diagnoses: [],
    obligations: [],
    capabilities: {},
    proposals: { all: [], byId: {}, byRequestKey: {}, byParentTask: {} },
    questions: { all: [], byId: {} },
    budgetExtensions: { all: [], byRequestKey: {} },
  }
}
