import {
  TASK_CONTRACT_VERSION,
  canonicalize,
  contractDigest,
  decompositionDigest,
  type DecompositionAdmission,
  type DecompositionIdentity,
  type TaskContract,
} from '../contract.ts'
import {
  ROOT_PROPOSAL_TASK_ID,
  TASK_PROPOSAL_DECISION_OUTCOMES,
  TASK_PROPOSAL_KINDS,
  TASK_PROPOSAL_PHASES,
  admissionContextDigest,
  batchIdFor,
  reviewContextDigest,
  rootProposalDigest,
  type RootProposalIdentity,
  type TaskProposal,
  type TaskProposalBase,
  type TaskProposalBatchConsumption,
  type TaskProposalChild,
  type TaskProposalConsumption,
  type TaskProposalDecisionClaim,
  type TaskProposalDecomposition,
  type TaskProposalIndex,
  type TaskProposalPhase,
  type TaskProposalPhaseChange,
  type TaskProposalReviewContext,
  type TaskProposalRoot,
  type TaskProposalRootConsumption,
  type TaskProposalStatus,
} from '../proposal.ts'
import { JUDGED_DIMENSIONS, JUDGEMENT_VERDICTS, reaches } from '../types.ts'
import { answerIdOf, questionIdOf } from '../question.ts'
import type { QuestionAnswerRecord, QuestionMessageRef, QuestionRecord, TaskQuestionIndex } from '../question.ts'
import type {
  DependencyEdge,
  Diagnosis,
  ExecutionPhase,
  Obligation,
  ProposalTargetType,
  ReviewRecord,
  RunId,
  RunProviderBinding,
  RunStatus,
  SubmissionRecord,
  TaskEvent,
  TaskEventPayloads,
  TaskId,
  TaskInstance,
  TaskRun,
  TaskSnapshot,
  TaskStatus,
} from '../types.ts'

function copy<T>(value: T): T {
  return structuredClone(value)
}

const ADMITTED_OR_LATER: readonly TaskStatus[] = ['admitted', 'ready', 'running', 'verifying', 'verified', 'failed']

const EXECUTION_PHASES: readonly ExecutionPhase[] = ['active', 'waiting_children', 'submitted']

const PROPOSAL_TARGET_TYPES: readonly ProposalTargetType[] = [
  'skill', 'tool', 'capability', 'task_definition', 'decomposition_policy',
  'agent_preset', 'workflow_policy', 'verifier', 'runtime_policy',
]

/**
 * The statuses each decision may be taken from — the one thing a decision's
 * legality is checked against. `approved` and `rejected` require a proposal
 * that actually waited for review (a policy-off batch has no review to decide),
 * while `cancelled` and `expired` may also land on a `ready` or `approved`
 * proposal: withdrawing a batch and invalidating a late approval are things
 * that happen to a batch nobody is reviewing.
 */
const DECISION_SOURCES: Readonly<Record<TaskProposalDecisionClaim['outcome'], readonly TaskProposalStatus[]>> = {
  approved: ['pending_review'],
  rejected: ['pending_review'],
  cancelled: ['ready', 'pending_review', 'approved'],
  expired: ['ready', 'pending_review', 'approved'],
}

/**
 * The statuses each runtime phase change may come from. `pending_review` is
 * reachable only from `ready` (the deployment tightened to `all` before the
 * batch was admitted) and never from `pending_review` itself — re-asking for a
 * review a proposal is already waiting for would fake progress. `ready` is
 * reachable only from `approved`: that edge *is* the post-approval re-check
 * passing, so it cannot be written for a proposal nobody approved. `stale`
 * invalidates a re-check, so it applies to what a re-check can reach: a
 * re-checked approval or an un-admitted `ready` proposal (§6 runs the re-check
 * after approval and before admission; a proposal still awaiting review is not
 * re-checked — it expires or is decided instead).
 */
const PHASE_SOURCES: Readonly<Record<TaskProposalPhase, readonly TaskProposalStatus[]>> = {
  ready: ['approved'],
  pending_review: ['ready'],
  stale: ['ready', 'approved'],
}

/** The only status a consumption may come from: the re-check has to have passed and be on the record. */
const ADMISSION_SOURCES: readonly TaskProposalStatus[] = ['ready']

/** The closed field set of a review context ({@link TaskProposalReviewContext}); an unread field must not move an identity. */
const REVIEW_CONTEXT_FIELDS: readonly string[] = ['capabilityManifestDigest', 'verifiers']

/** The closed field set of one batch child ({@link TaskProposalChild}); an unread field must not enter an identity. */
const PROPOSAL_CHILD_FIELDS: readonly string[] = ['contract', 'dependsOn', 'decomposable', 'requiresIndependentAcceptance']

/** The closed field set of one verifier identity ({@link TaskProposalVerifierIdentity}). */
const VERIFIER_IDENTITY_FIELDS: readonly string[] = ['verifierId', 'version', 'configurationDigest']

/** The closed field set of a decomposition identity ({@link DecompositionIdentity}): what its digest covers, and nothing else. */
const DECOMPOSITION_IDENTITY_FIELDS: readonly string[] = [
  'contractVersion', 'storeId', 'parentTaskId', 'parentRunId', 'callerSessionId', 'reason', 'children',
]

/** The closed field set of a root contract identity ({@link RootProposalIdentity}). */
const ROOT_IDENTITY_FIELDS: readonly string[] = [
  'contractVersion', 'storeId', 'rootSessionId', 'requestKey', 'contractDigest',
]

/** The batch vocabulary a root consumption must not carry: the ids it names are a task id and a run id, not a batch. */
const BATCH_CONSUMPTION_FIELDS: readonly string[] = ['batchId', 'parentRunId', 'childTaskIds']

/** The root vocabulary a batch consumption must not carry. */
const ROOT_CONSUMPTION_FIELDS: readonly string[] = ['rootTaskId', 'rootRunId']

/** One store's proposal index with nothing in it; what a store without proposals answers. */
function emptyProposalIndex(): TaskProposalIndex {
  return { all: [], byId: {}, byRequestKey: {}, byParentTask: {} }
}

/** One store's question index with nothing in it; what a store without questions answers. */
function emptyQuestionIndex(): TaskQuestionIndex {
  return { all: [], byId: {} }
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/** A lowercase SHA-256 hex digest: the only shape a content or context identity is accepted in. */
function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

/** Plain-object test: `null` and arrays are not records, whatever `typeof` says. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export class TaskState {
  private value: TaskSnapshot

  constructor(id: string, snapshot?: TaskSnapshot) {
    this.value = snapshot === undefined
      ? {
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
          proposals: emptyProposalIndex(),
          questions: emptyQuestionIndex(),
        }
      : copy(snapshot)
  }

  clone(): TaskState {
    return new TaskState(this.value.id, this.value)
  }

  snapshot(): TaskSnapshot {
    return copy(this.value)
  }

  apply(event: TaskEvent): void {
    switch (event.kind) {
      case 'TaskCreated': this.addTask(event.payload.task); return
      case 'TaskAdmitted': this.admit(event.taskId, event.payload.decompositionStatus); return
      case 'TaskRejected': this.transit(event.taskId, ['created'], 'blocked'); return
      case 'TaskDecomposed': this.decompose(event.taskId, event.payload); return
      case 'DependencyAdded': this.addDependency(event.payload.edge); return
      case 'TaskStarted': this.start(event.taskId, event.runId, event.payload.run); return
      case 'TaskBlocked': this.block(event.taskId, event.runId); return
      case 'TaskVerifying': this.transit(event.taskId, ['running'], 'verifying'); return
      case 'TaskVerified': this.verify(event.taskId, event.runId, event.payload.finishedAt); return
      case 'TaskFailed': this.fail(event.taskId, event.runId, event.payload.finishedAt); return
      case 'TaskCancelled': this.cancel(event.taskId, event.runId, event.payload.finishedAt); return
      case 'TaskRetried': this.transit(event.taskId, ['failed'], 'ready'); return
      case 'RunPhaseChanged': this.changeRunPhase(event.taskId, event.runId, event.payload); return
      case 'RunProgressMarked': this.markRunProgress(event.taskId, event.runId, event.payload, event.timestamp); return
      case 'QuestionAsked': this.askQuestion(event.taskId, event.runId, event.parentTaskId, event.payload.question); return
      case 'QuestionAnswered': this.answerQuestion(event.taskId, event.runId, event.parentTaskId, event.payload.answer); return
      case 'CapabilityResolved': this.resolveCapabilities(event.taskId, event.payload.manifest); return
      case 'CapabilityGapDetected': this.task(event.taskId); return
      case 'EvidenceProduced': this.produceEvidence(event.taskId, event.runId, event.payload.evidence); return
      case 'HandoffCreated': this.addHandoff(event.payload.handoff); return
      case 'ReviewRecorded': this.recordReview(event.taskId, event.runId, event.payload.review); return
      case 'DiagnosisRecorded': this.recordDiagnosis(event.taskId, event.payload.diagnosis); return
      case 'ObligationRecorded': this.recordObligation(event.payload.obligation); return
      case 'TaskProposalSubmitted': this.submitProposal(event.taskId, event.payload.proposal); return
      case 'TaskProposalDecided': this.decideProposal(event.taskId, event.payload, event.timestamp); return
      case 'TaskProposalPhaseChanged': this.changeProposalPhase(event.taskId, event.payload, event.timestamp); return
      case 'TaskProposalAdmitted': this.admitProposal(event.taskId, event.payload, event.timestamp); return
      default: throw new Error(`task: unknown event kind "${(event as { kind?: unknown }).kind}"`)
    }
  }

  private addTask(task: TaskInstance): void {
    if (typeof task.taskId !== 'string' || task.taskId.length === 0) throw new Error('task: task id must be a non-empty string')
    if (typeof task.objective !== 'string' || task.objective.length === 0) throw new Error(`task: task "${task.taskId}" objective must be non-empty`)
    if (this.value.tasks.some(item => item.taskId === task.taskId)) throw new Error(`task: task "${task.taskId}" already exists`)
    if (task.status !== 'created') throw new Error(`task: task "${task.taskId}" must be created in status "created"`)
    if (task.runIds.length !== 0 || task.childTaskIds.length !== 0) throw new Error('task: task runs and children must use events')
    if (task.parentTaskId === task.taskId) throw new Error(`task: task "${task.taskId}" cannot be its own parent`)
    if (task.contract !== undefined) this.assertContract(task.taskId, task.contract, task)
    if (task.parentTaskId === undefined) {
      if (task.depth !== 0) throw new Error(`task: root task "${task.taskId}" depth must be 0`)
      this.value = { ...this.value, tasks: [...this.value.tasks, copy(task)] }
      return
    }
    const parent = this.task(task.parentTaskId)
    if (task.depth !== parent.depth + 1) throw new Error(`task: task "${task.taskId}" depth must be parent depth + 1`)
    this.value = {
      ...this.value,
      tasks: [
        ...this.value.tasks.map(item => item.taskId === parent.taskId
          ? { ...item, childTaskIds: [...item.childTaskIds, task.taskId] }
          : item),
        copy(task),
      ],
    }
  }

  /**
   * A task's contract is either absent — a task created before the contract
   * existed — or the single source its projection fields are generated from.
   * The check re-derives the projections from the contract and refuses a
   * disagreement instead of letting either side stand in for the other: a
   * reader that trusts `objective` and one that trusts `contract.objective`
   * must never see two different goals. Structural comparison goes through
   * `canonicalize`, so key order in the stored payload is not a difference.
   */
  private assertContract(taskId: TaskId, contract: TaskContract, task: TaskInstance): void {
    this.assertContractFields(`task "${taskId}"`, contract)
    if (task.objective !== contract.objective) {
      throw new Error(`task: task "${taskId}" objective disagrees with its contract objective`)
    }
    if (canonicalize(task.acceptanceCriteria) !== canonicalize(contract.acceptanceCriteria)) {
      throw new Error(`task: task "${taskId}" acceptance criteria disagree with its contract`)
    }
    if (canonicalize(task.requestedCapabilities) !== canonicalize(contract.requiredCapabilities)) {
      throw new Error(`task: task "${taskId}" requested capabilities disagree with its contract`)
    }
  }

  /**
   * The contract fields one normalized contract must carry, checked the same
   * way wherever a contract is stored — on a task (T1) and on each child of a
   * proposal's batch (T2). `where` names the record being checked, so a refusal
   * says which contract it came from instead of "some contract is malformed".
   *
   * Shape only: whether the contract is the *right* one is a question the
   * callers answer (a task's projections must agree with it; a proposal's batch
   * must digest to its identity's child digest).
   */
  private assertContractFields(where: string, contract: TaskContract): void {
    if (contract.contractVersion !== TASK_CONTRACT_VERSION) {
      throw new Error(`task: ${where} declares contract version ${String(contract.contractVersion)}; this build stores version ${TASK_CONTRACT_VERSION}`)
    }
    const lists: ReadonlyArray<readonly [string, unknown]> = [
      ['assumptions', contract.assumptions],
      ['constraints', contract.constraints],
      ['requiredCapabilities', contract.requiredCapabilities],
    ]
    for (const [name, value] of lists) {
      if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
        throw new Error(`task: ${where} contract ${name} must be an array of strings`)
      }
    }
    if (typeof contract.objective !== 'string') {
      throw new Error(`task: ${where} contract objective must be a string`)
    }
  }

  /**
   * The batch record a decomposition carries is the identity a later review
   * gate binds an approval to, so a malformed one is refused rather than
   * stored: an empty proposal digest or a non-numeric limit would make the
   * record unusable exactly when someone needs to compare it.
   */
  private assertAdmission(taskId: TaskId, admission: DecompositionAdmission): void {
    if (typeof admission.proposalDigest !== 'string' || admission.proposalDigest.length === 0) {
      throw new Error(`task: task "${taskId}" decomposition admission requires a proposal digest`)
    }
    const context = admission.context
    if (!isRecord(context)) {
      throw new Error(`task: task "${taskId}" decomposition admission requires an admission context`)
    }
    this.assertAdmissionLimits(`task "${taskId}" admission context`, context)
  }

  /**
   * The limits one admission context carries, checked the same way wherever one
   * is stored — on a decomposition (T1) and on a proposal (T2: the limits the
   * batch was submitted under, whose fingerprint an approval binds). `where`
   * names the record being checked, so a refusal says which producer it came
   * from instead of "some context is malformed".
   */
  private assertAdmissionLimits(where: string, context: Record<string, unknown>): void {
    for (const [name, value] of [['maxDepth', context.maxDepth], ['maxChildren', context.maxChildren]] as const) {
      if (!Number.isInteger(value) || (value as number) < 0) {
        throw new Error(`task: ${where} ${name} must be a non-negative integer`)
      }
    }
    const auditOnly: unknown = context.auditOnly
    if (!isRecord(auditOnly)) {
      throw new Error(`task: ${where} auditOnly must be an object`)
    }
    const limits: ReadonlyArray<readonly [string, unknown]> = [
      ['wallTimeMs', context.wallTimeMs],
      ['auditOnly.maxToolCalls', auditOnly.maxToolCalls],
      ['auditOnly.tokens', auditOnly.tokens],
      ['auditOnly.attempts', auditOnly.attempts],
    ]
    for (const [name, value] of limits) {
      if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value))) {
        throw new Error(`task: ${where} ${name} must be a finite number when present`)
      }
    }
  }

  private admit(taskId: TaskId, decompositionStatus: 'leaf' | 'decomposable'): void {
    this.assertTransition(taskId, ['created'], 'admitted')
    this.updateTask(taskId, { status: 'admitted', decompositionStatus })
  }

  /**
   * A decomposition records the members one batch contributed to the parent:
   * the children are already under it (`TaskCreated`), and this event says they
   * were admitted together, as one batch, by one run.
   *
   * A parent decomposes more than once — one batch per delegation round — so
   * there is no once-in-a-life gate here: a second admission of different
   * content under a different batch identity is the normal case. What must be
   * refused is the *same* batch twice: one (run, proposal) pair names one
   * batch, and a second record under it would count the same members twice and
   * let one batch answer two ways. The batch a run waits on is the run's own
   * (`batchId`, `RunPhaseChanged`), while the members accumulate on the parent
   * in event order — a member from an earlier batch is never dropped by a later
   * one.
   *
   * The batch identity is all three fields or none: an event written before
   * batches were identified by `(parentRunId, proposalId)` carries none of them
   * and is read as the decomposition it was, with no run accumulation invented
   * for it (see `docs/persistence-changes/2026-09-26-k1-multi-batch.md`). An
   * event that names one must name a real run of this task and must carry the
   * id that pair derives, so a batch id in the store can never be read as
   * another batch's.
   *
   * `decompositionStatus` is still written (the parent closes as `decomposed`,
   * and a record from before this rule keeps its old meaning) but nothing here
   * gates on it: it is history a reader may show, not a permission.
   */
  private decompose(taskId: TaskId, payload: TaskEventPayloads['TaskDecomposed']): void {
    const parent = this.task(taskId)
    for (const childTaskId of payload.childTaskIds) {
      if (!parent.childTaskIds.includes(childTaskId)) throw new Error(`task: task "${childTaskId}" is not a child of "${taskId}"`)
    }
    if (payload.childTaskIds.length === 0
      || payload.childTaskIds.some(childTaskId => !ADMITTED_OR_LATER.includes(this.task(childTaskId).status))) {
      throw new Error(`task: task "${taskId}" cannot decompose without an admitted child`)
    }
    if (payload.admission !== undefined) this.assertAdmission(taskId, payload.admission)
    const batch = this.assertBatchIdentity(taskId, payload)
    this.updateTask(taskId, { decompositionStatus: 'decomposed' })
    if (batch === undefined) return
    this.value = {
      ...this.value,
      runs: this.value.runs.map(item => item.runId === batch.parentRunId
        ? {
            ...item,
            batches: [...(item.batches ?? []), {
              batchId: batch.batchId,
              proposalId: batch.proposalId,
              memberTaskIds: [...payload.childTaskIds],
            }],
          }
        : item),
    }
  }

  /**
   * The batch identity one decomposition event carries, or `undefined` for a
   * record written before batches had one. The three fields are one fact, so
   * two of them is not a half-batch but a malformed record, and a record that
   * carries the id of a batch the run already holds is the second record of one
   * batch — both are refused rather than half-applied. The id must be exactly
   * {@link batchIdFor} of the pair it names, so a reader that derives a batch id
   * (the writer, a recovery, the composite judge's member positions) and the id
   * in the log cannot be two different addresses for one batch.
   */
  private assertBatchIdentity(
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
    const run = this.run(parentRunId)
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

  /**
   * The content identity a run records is what a later reader re-checks the
   * snapshot against, so a malformed record is refused rather than stored: a
   * digest that is not a digest, or a skill entry without a name, would make the
   * record unusable exactly when someone asks whether an execution's bound
   * content is still the content on disk. Only the shape is judged here — the
   * bytes are the runtime's business, and a record whose snapshot no longer
   * matches is a refusal its reader reports, not a reason to reject the event
   * that already happened.
   */
  private assertProviderBinding(runId: RunId, binding: RunProviderBinding): void {
    if (typeof binding.registryRevision !== 'string' || binding.registryRevision.length === 0) {
      throw new Error(`task: run "${runId}" provider binding requires a registry revision`)
    }
    const list = (name: string, value: unknown): unknown[] => {
      if (!Array.isArray(value)) throw new Error(`task: run "${runId}" provider binding ${name} must be an array`)
      return value
    }
    for (const name of list('capabilities', binding.capabilities)) {
      if (typeof name !== 'string' || name.length === 0) {
        throw new Error(`task: run "${runId}" provider binding capability names must be non-empty strings`)
      }
    }
    const digest = (where: string, value: unknown, nullable: boolean): void => {
      if (nullable && value === null) return
      if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
        throw new Error(`task: run "${runId}" provider binding ${where} must be a lowercase SHA-256 hex digest${nullable ? ' or null' : ''}`)
      }
    }
    for (const entry of list('skills', binding.skills)) {
      if (!isRecord(entry)) throw new Error(`task: run "${runId}" provider binding skill entries must be objects`)
      if (typeof entry.name !== 'string' || entry.name.length === 0) {
        throw new Error(`task: run "${runId}" provider binding skill requires a name`)
      }
      if (entry.role !== 'execution-provider' && entry.role !== 'knowledge' && entry.role !== 'guidance') {
        throw new Error(`task: run "${runId}" provider binding skill "${entry.name}" has an unknown role ${JSON.stringify(entry.role)}`)
      }
      if (typeof entry.description !== 'string') {
        throw new Error(`task: run "${runId}" provider binding skill "${entry.name}" requires a description`)
      }
      const capabilities: unknown = entry.capabilities
      if (!Array.isArray(capabilities) || capabilities.some(item => typeof item !== 'string')) {
        throw new Error(`task: run "${runId}" provider binding skill "${entry.name}" capabilities must be an array of strings`)
      }
      const uncovered: unknown = entry.uncovered
      if (!Array.isArray(uncovered) || uncovered.some(item => typeof item !== 'string')) {
        throw new Error(`task: run "${runId}" provider binding skill "${entry.name}" uncovered must be an array of strings`)
      }
      digest(`skill "${entry.name}" contractDigest`, entry.contractDigest, true)
      digest(`skill "${entry.name}" contentDigest`, entry.contentDigest, false)
    }
    for (const entry of list('mcpServers', binding.mcpServers)) {
      if (!isRecord(entry)) throw new Error(`task: run "${runId}" provider binding MCP entries must be objects`)
      if (typeof entry.serverName !== 'string' || entry.serverName.length === 0) {
        throw new Error(`task: run "${runId}" provider binding MCP entry requires a server name`)
      }
      digest(`MCP server "${entry.serverName}" templateDigest`, entry.templateDigest, true)
    }
    if (binding.snapshotRoot !== undefined && (typeof binding.snapshotRoot !== 'string' || binding.snapshotRoot.length === 0)) {
      throw new Error(`task: run "${runId}" provider binding snapshotRoot must be a non-empty path when present`)
    }
  }

  /**
   * The submission record is what a reader trusts instead of re-reading the
   * worker's transcript, so a malformed one is refused rather than stored: an
   * unnamed summary or a ref list that is not a list would leave the record
   * unusable exactly when someone asks what was handed in. Shape only —
   * whether the refs point at anything the store holds is judged by the
   * acceptance reader.
   */
  private assertSubmissionShape(runId: RunId, submission: SubmissionRecord): void {
    if (!isRecord(submission)) throw new Error(`task: run "${runId}" submission must be an object`)
    if (!nonEmpty(submission.summary)) throw new Error(`task: run "${runId}" submission requires a summary`)
    if (!Array.isArray(submission.evidenceRefs) || submission.evidenceRefs.some(item => typeof item !== 'string')) {
      throw new Error(`task: run "${runId}" submission evidence refs must be an array of strings`)
    }
    if (submission.notes !== undefined && typeof submission.notes !== 'string') {
      throw new Error(`task: run "${runId}" submission notes must be a string when present`)
    }
    if (submission.origin !== 'worker' && submission.origin !== 'runtime') {
      throw new Error(`task: run "${runId}" submission origin must be "worker" or "runtime"`)
    }
    if (!nonEmpty(submission.submittedAt)) throw new Error(`task: run "${runId}" submission requires a submission time`)
  }

  /**
   * A run's birth phase is written by the runtime, and the reducer judges its
   * shape only — the transition semantics belong to `changeRunPhase`. A run
   * with no phase is a record from before the protocol and stays legal; a run
   * born `active` carries neither a submission, a batch nor an accumulation of
   * batches; a run born `submitted` (a workerless replay) must carry a
   * well-shaped submission and no batch either. `waiting_children` is not a
   * birth phase: no creation path admits a batch before the run exists, and a
   * run's `batches` are the decompositions it admits — facts the store already
   * holds as tasks — never a projection a caller hands in.
   */
  private assertBirthPhase(run: TaskRun): void {
    const phase = run.executionPhase
    if (phase === undefined) return
    if (phase !== 'active' && phase !== 'submitted') {
      throw new Error(`task: run "${run.runId}" execution phase must be "active" or "submitted" at start`)
    }
    if (run.batchId !== undefined) {
      throw new Error(`task: run "${run.runId}" is born ${phase}; a batch id is recorded by a phase change, not at start`)
    }
    if (run.batches !== undefined) {
      throw new Error(`task: run "${run.runId}" is born ${phase}; a run's batches are recorded by the decompositions it admits, not at start`)
    }
    if (phase === 'active') {
      if (run.submission !== undefined) {
        throw new Error(`task: run "${run.runId}" is born active; only a submitted run carries a submission`)
      }
      return
    }
    if (run.submission === undefined) {
      throw new Error(`task: run "${run.runId}" is born submitted; a submission record is required`)
    }
    this.assertSubmissionShape(run.runId, run.submission)
  }

  /**
   * The A3 question-id mount points ride on a phase change and are read-only
   * since A4: the question records are the one durable source of what a run
   * waits on, and this build's write entries refuse a phase change that carries
   * either field. Records already in a log still have to replay to the snapshot
   * they produced, so the reducer keeps shape-checking and carrying them — an
   * empty list is a legitimate shape and is stored as given.
   */
  private assertQuestionIds(runId: RunId, payload: TaskEventPayloads['RunPhaseChanged']): void {
    const lists: ReadonlyArray<readonly [string, unknown]> = [
      ['pendingQuestionIds', payload.pendingQuestionIds],
      ['blockingQuestionIds', payload.blockingQuestionIds],
    ]
    for (const [name, value] of lists) {
      if (value !== undefined && (!Array.isArray(value) || value.some(item => typeof item !== 'string'))) {
        throw new Error(`task: run "${runId}" ${name} must be an array of strings`)
      }
    }
  }

  private addDependency(edge: DependencyEdge): void {
    this.task(edge.from)
    this.task(edge.to)
    if (edge.from === edge.to || reaches(this.value.edges, edge.to, edge.from)) {
      throw new Error(`task: dependency "${edge.from}" → "${edge.to}" creates a cycle`)
    }
    if (this.value.edges.some(item => item.from === edge.from && item.to === edge.to)) {
      throw new Error(`task: dependency "${edge.from}" → "${edge.to}" already exists`)
    }
    this.value = { ...this.value, edges: [...this.value.edges, copy(edge)] }
  }

  private start(taskId: TaskId, envelopeRunId: RunId | undefined, run: TaskRun): void {
    if (typeof run.runId !== 'string' || run.runId.length === 0) throw new Error('task: run id must be a non-empty string')
    if (this.value.runs.some(item => item.runId === run.runId)) throw new Error(`task: run "${run.runId}" already exists`)
    if (run.taskId !== taskId) throw new Error(`task: run "${run.runId}" does not belong to task "${taskId}"`)
    if (envelopeRunId !== run.runId) throw new Error(`task: run "${run.runId}" envelope run id mismatch`)
    if (run.status !== 'running') throw new Error(`task: run "${run.runId}" must start in status "running"`)
    if (typeof run.sessionId !== 'string' || run.sessionId.length === 0) throw new Error(`task: run "${run.runId}" session id must be non-empty`)
    if (run.providerBinding !== undefined) this.assertProviderBinding(run.runId, run.providerBinding)
    this.assertBirthPhase(run)
    if (run.parentRunId !== undefined) this.run(run.parentRunId)
    this.assertTransition(taskId, ['admitted', 'ready'], 'running')
    this.value = { ...this.value, runs: [...this.value.runs, copy(run)] }
    this.updateTask(taskId, { status: 'running', runIds: [...this.task(taskId).runIds, run.runId] })
  }

  private block(taskId: TaskId, runId: RunId | undefined): void {
    this.assertTransition(taskId, ['admitted', 'ready', 'running'], 'blocked')
    if (runId !== undefined) this.assertRunTransition(runId, ['running'], 'blocked')
    this.updateTask(taskId, { status: 'blocked' })
    if (runId !== undefined) this.setRun(runId, 'blocked')
  }

  private verify(taskId: TaskId, runId: RunId | undefined, finishedAt: string | undefined): void {
    if (runId === undefined) throw new Error(`task: TaskVerified for "${taskId}" requires a run id`)
    this.assertTransition(taskId, ['verifying'], 'verified')
    if (!this.value.evidence.some(item => item.taskId === taskId && item.taskRunId === runId)) {
      throw new Error(`task: run "${runId}" has no evidence`)
    }
    this.assertRunTransition(runId, ['running'], 'verified')
    this.updateTask(taskId, { status: 'verified' })
    this.setRun(runId, 'verified', finishedAt)
  }

  private fail(taskId: TaskId, runId: RunId | undefined, finishedAt: string | undefined): void {
    this.assertTransition(taskId, ['running', 'verifying'], 'failed')
    if (runId !== undefined) this.assertRunTransition(runId, ['running', 'blocked'], 'failed')
    this.updateTask(taskId, { status: 'failed' })
    if (runId !== undefined) this.setRun(runId, 'failed', finishedAt)
  }

  /**
   * A run keeps `running` through verification (the coordination phase, not the
   * status, is what records the submission), so a cancellation that lands while a
   * verifier call is in flight arrives at a task that is already `verifying`.
   * Refusing it would leave the tree half-settled — the parent cancelled, the
   * verifying child not — and make the documented exit for a store that cannot be
   * recovered (`cancelGraph`) impossible exactly when it is needed. `failed`
   * already accepts both source statuses; this is the same rule for `cancelled`.
   */
  private cancel(taskId: TaskId, runId: RunId | undefined, finishedAt: string | undefined): void {
    this.assertTransition(taskId, ['running', 'verifying'], 'cancelled')
    if (runId !== undefined) this.assertRunTransition(runId, ['running', 'blocked'], 'cancelled')
    this.updateTask(taskId, { status: 'cancelled' })
    if (runId !== undefined) this.setRun(runId, 'cancelled', finishedAt)
  }

  /**
   * The coordination phase is the A3 admission gate, so this handler is where
   * a transition is either one of the four legal edges or a refusal: a run
   * accepts `active → waiting_children`, `waiting_children → active`,
   * `active → submitted` and `waiting_children → submitted`, and nothing else.
   * Same phase, a rollback, a run with no phase at all and a run that is no
   * longer running are all refused, because "already submitted" has to be
   * answered by this one field — a second submission that overwrote the first
   * record would make the field answer differently at two reads.
   *
   * The two batch edges carry the batch they name — the one opened on the way
   * out and the one closed on the way back — and the return edge clears the
   * run's current batch id: after `waiting_children → active` the run holds no
   * unfinished batch, while the batches it admitted stay in `batches` as
   * history. Returning to `active` therefore does not erase which batches ran;
   * it says the parent is free to open another one.
   *
   * The run status is checked first because a phase change on a failed or
   * cancelled run is late by definition; verification is the case the phase
   * guard exists for, since a run inside it is still `running`.
   *
   * Only the payload's shape is judged: the batch a run waits on and what it
   * submitted are the writer's statements, and A4's question ids are carried,
   * not interpreted.
   */
  private changeRunPhase(taskId: TaskId, runId: RunId | undefined, payload: TaskEventPayloads['RunPhaseChanged']): void {
    if (runId === undefined) throw new Error(`task: RunPhaseChanged for task "${taskId}" requires a run id`)
    const run = this.run(runId)
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
    const legal = (from === 'active' && (to === 'waiting_children' || to === 'submitted'))
      || (from === 'waiting_children' && (to === 'active' || to === 'submitted'))
    if (!legal) throw new Error(`task: illegal run phase transition "${from}" → "${to}" for run "${runId}"`)
    if (to === 'waiting_children' || to === 'active') {
      if (!nonEmpty(payload.batchId)) {
        throw new Error(to === 'waiting_children'
          ? `task: run "${runId}" entering waiting_children requires a batch id`
          : `task: run "${runId}" returning to active requires the batch id it closes`)
      }
      if (payload.submission !== undefined) {
        throw new Error(`task: run "${runId}" is entering ${to}; only the submitted phase carries a submission`)
      }
    } else {
      if (payload.submission === undefined) throw new Error(`task: run "${runId}" submitting requires a submission record`)
      this.assertSubmissionShape(runId, payload.submission)
      if (payload.batchId !== undefined) {
        throw new Error(`task: run "${runId}" is submitting; a batch id belongs to the batch edges, not the submitted phase`)
      }
    }
    this.assertQuestionIds(runId, payload)
    this.value = {
      ...this.value,
      runs: this.value.runs.map(item => {
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
  }

  /**
   * A no-progress marking is the A3 signal a reader shows before the budget
   * stops a stuck run, and it is meaningful only on the phase that can still
   * submit: `active`. A run waiting on children or on verification is expected
   * to be idle — marking it would count a legitimate wait as stagnation and
   * give the budget a reason to stop work that is still under way. `rounds` is
   * the caller's consecutive count; the reducer records the number it is given
   * and never accumulates, so replay and live observation agree.
   */
  private markRunProgress(
    taskId: TaskId,
    runId: RunId | undefined,
    payload: TaskEventPayloads['RunProgressMarked'],
    timestamp: string,
  ): void {
    if (runId === undefined) throw new Error(`task: RunProgressMarked for task "${taskId}" requires a run id`)
    const run = this.run(runId)
    if (run.taskId !== taskId) throw new Error(`task: run "${runId}" belongs to task "${run.taskId}", not "${taskId}"`)
    if (run.status !== 'running') {
      throw new Error(`task: run "${runId}" is ${run.status}; progress can only be marked while the run is running`)
    }
    const phase = run.executionPhase
    if (phase !== 'active') {
      throw new Error(`task: run "${runId}" execution phase is ${phase === undefined ? 'absent' : `"${phase}"`}; progress is only marked on an active run`)
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
    this.value = {
      ...this.value,
      runs: this.value.runs.map(item => item.runId === runId
        ? { ...item, noProgress: { kind: payload.kind, rounds: payload.rounds, factCount: payload.factCount, markedAt: timestamp } }
        : item),
    }
  }

  /**
   * A child run asks its direct parent (A4 §F.1). The reducer is the gate for
   * the whole shape, in this order: the record must be well-formed, its id must
   * be the identity its own (child run, request key) pair derives, the asking
   * run must exist and still be running, its task must have a direct parent
   * (a root or parentless replay task has nobody to ask, and the refusal names
   * that rather than inventing a parent), the parent task's *current* run must
   * be the one the record names and must be running, and the cited Session must
   * be the asking run's own — a citation into some other Session could point at
   * text this store never saw. The envelope is checked against the same facts:
   * it names the asking run, the child task, and the parent task.
   *
   * The parent run is resolved here, not taken from the caller: an ask cannot
   * choose its addressee, and a parent run that settled after the caller's
   * read closes the ask by name (the entry's own check is advisory; this one
   * binds, because it runs inside the commit).
   */
  private askQuestion(
    taskId: TaskId,
    envelopeRunId: RunId | undefined,
    envelopeParentTaskId: TaskId | undefined,
    question: QuestionRecord,
  ): void {
    if (!isRecord(question)) throw new Error('task: question must be an object')
    if (!nonEmpty(question.questionId)) throw new Error('task: question id must be a non-empty string')
    const id = question.questionId
    if (!nonEmpty(question.requestKey)) throw new Error(`task: question "${id}" request key must be a non-empty string`)
    if (!nonEmpty(question.messageId)) throw new Error(`task: question "${id}" message id must be a non-empty string`)
    if (!isDigest(question.questionDigest)) throw new Error(`task: question "${id}" content digest must be a lowercase SHA-256 hex digest`)
    if (typeof question.blocking !== 'boolean') throw new Error(`task: question "${id}" blocking must be a boolean`)
    if (!nonEmpty(question.askedAt)) throw new Error(`task: question "${id}" requires an ask time`)
    if (question.answers !== undefined) throw new Error(`task: question "${id}" is asked without answers; an answer is its own event`)
    this.assertMessageRef(`question "${id}"`, question.questionRef)
    const derived = questionIdOf({ childRunId: question.childRunId, requestKey: question.requestKey })
    if (id !== derived) {
      throw new Error(
        `task: question id "${id}" is not the identity of child run "${question.childRunId}" and request key "${question.requestKey}" ("${derived}")`,
      )
    }
    const child = this.run(question.childRunId)
    if (envelopeRunId !== child.runId) {
      throw new Error(`task: question "${id}" envelope run id mismatch: the asking run is "${child.runId}", the envelope names "${String(envelopeRunId)}"`)
    }
    const childTask = this.task(child.taskId)
    if (taskId !== childTask.taskId) {
      throw new Error(`task: question "${id}" is asked by run "${child.runId}" of task "${childTask.taskId}", not "${taskId}"`)
    }
    if (child.status !== 'running') {
      throw new Error(`task: child run "${child.runId}" is ${child.status}; a question requires a running run`)
    }
    if (childTask.parentTaskId === undefined) {
      throw new Error(`task: task "${childTask.taskId}" has no parent task; a root or parentless replay task cannot ask a parent`)
    }
    const parentTask = this.task(childTask.parentTaskId)
    if (envelopeParentTaskId !== parentTask.taskId) {
      throw new Error(`task: question "${id}" must carry parent task id "${parentTask.taskId}"; the envelope names "${String(envelopeParentTaskId)}"`)
    }
    const parentRunId = parentTask.runIds[parentTask.runIds.length - 1]
    if (parentRunId === undefined) throw new Error(`task: parent task "${parentTask.taskId}" has no run for question "${id}"`)
    const parentRun = this.run(parentRunId)
    if (question.parentRunId !== parentRun.runId) {
      throw new Error(`task: question "${id}" names parent run "${question.parentRunId}"; task "${parentTask.taskId}"'s current run is "${parentRun.runId}"`)
    }
    if (parentRun.status !== 'running') {
      throw new Error(`task: parent run "${parentRun.runId}" is ${parentRun.status}; a question requires a running parent run`)
    }
    if (question.questionRef.sessionId !== child.sessionId) {
      throw new Error(`task: question "${id}" cites session "${question.questionRef.sessionId}"; the asking run's session is "${child.sessionId}"`)
    }
    const index = this.questions()
    if (index.byId[id] !== undefined) throw new Error(`task: question "${id}" already exists`)
    const stored = copy(question)
    this.value = {
      ...this.value,
      questions: { all: [...index.all, stored], byId: { ...index.byId, [id]: stored } },
    }
  }

  /**
   * A parent run answers one of its children's questions (A4 §F.1). An answer
   * is appended to the question's record, so the reducer's job is to decide
   * whether this answer may join *this* question: the id must be the one its
   * (question, request key) pair derives, the question must exist, the
   * answering run must be the run the question was asked of (a wrong parent,
   * including the new run of a restarted task, is refused by name), both runs
   * must still be running, the question must not already be resolved, the cited
   * Session must be the answering run's own, and neither the envelope nor the
   * answer id may disagree with what is stored.
   *
   * A settled run is the late-answer case the plan fixes: the refusal happens
   * here, before anything is applied, so a terminal run is never revived and a
   * question nobody can answer leaves no new fact — the record stays as the
   * audit of what was asked. `resolves: false` is a complete answer that keeps
   * the question open, which is why the openness test reads the answers and not
   * a status.
   */
  private answerQuestion(
    taskId: TaskId,
    envelopeRunId: RunId | undefined,
    envelopeParentTaskId: TaskId | undefined,
    answer: QuestionAnswerRecord,
  ): void {
    if (!isRecord(answer)) throw new Error('task: answer must be an object')
    if (!nonEmpty(answer.answerId)) throw new Error('task: answer id must be a non-empty string')
    const id = answer.answerId
    if (!nonEmpty(answer.questionId)) throw new Error(`task: answer "${id}" question id must be a non-empty string`)
    if (!nonEmpty(answer.requestKey)) throw new Error(`task: answer "${id}" request key must be a non-empty string`)
    if (!nonEmpty(answer.messageId)) throw new Error(`task: answer "${id}" message id must be a non-empty string`)
    if (!isDigest(answer.answerDigest)) throw new Error(`task: answer "${id}" content digest must be a lowercase SHA-256 hex digest`)
    if (typeof answer.resolves !== 'boolean') throw new Error(`task: answer "${id}" resolves must be a boolean`)
    if (!nonEmpty(answer.answeredAt)) throw new Error(`task: answer "${id}" requires an answer time`)
    this.assertMessageRef(`answer "${id}"`, answer.answerRef)
    const derived = answerIdOf({ questionId: answer.questionId, requestKey: answer.requestKey })
    if (id !== derived) {
      throw new Error(
        `task: answer id "${id}" is not the identity of question "${answer.questionId}" and request key "${answer.requestKey}" ("${derived}")`,
      )
    }
    const question = this.questions().byId[answer.questionId]
    if (question === undefined) throw new Error(`task: unknown question "${answer.questionId}"`)
    if (answer.parentRunId !== question.parentRunId) {
      throw new Error(`task: answer "${id}" names parent run "${answer.parentRunId}"; question "${question.questionId}" was asked of run "${question.parentRunId}"`)
    }
    const child = this.run(question.childRunId)
    const parent = this.run(question.parentRunId)
    if (child.status !== 'running') {
      throw new Error(`task: question "${question.questionId}" is not open: child run "${child.runId}" is ${child.status}; a question requires a running run`)
    }
    if (parent.status !== 'running') {
      throw new Error(`task: question "${question.questionId}" is not open: parent run "${parent.runId}" is ${parent.status}; a question requires a running parent run`)
    }
    if (answer.answerRef.sessionId !== parent.sessionId) {
      throw new Error(`task: answer "${id}" cites session "${answer.answerRef.sessionId}"; the answering run's session is "${parent.sessionId}"`)
    }
    if (envelopeRunId !== parent.runId) {
      throw new Error(`task: answer "${id}" envelope run id mismatch: the answering run is "${parent.runId}", the envelope names "${String(envelopeRunId)}"`)
    }
    const childTask = this.task(child.taskId)
    if (taskId !== childTask.taskId) {
      throw new Error(`task: answer "${id}" belongs to run "${child.runId}" of task "${childTask.taskId}", not "${taskId}"`)
    }
    if (envelopeParentTaskId !== parent.taskId) {
      throw new Error(`task: answer "${id}" must carry parent task id "${parent.taskId}"; the envelope names "${String(envelopeParentTaskId)}"`)
    }
    const answers = question.answers ?? []
    if (answers.some(item => item.resolves)) {
      throw new Error(`task: question "${question.questionId}" is already resolved; answer "${id}" is refused`)
    }
    if (answers.some(item => item.answerId === id)) throw new Error(`task: answer "${id}" already exists`)
    const stored: QuestionRecord = { ...question, answers: [...answers, copy(answer)] }
    const replace = (questions: readonly QuestionRecord[]): QuestionRecord[] =>
      questions.map(item => (item.questionId === question.questionId ? stored : item))
    this.value = {
      ...this.value,
      questions: { all: replace(this.questions().all), byId: { ...this.questions().byId, [question.questionId]: stored } },
    }
  }

  /** A cited body reference: the sending Session, and a seq inside its log. */
  private assertMessageRef(where: string, ref: QuestionMessageRef): void {
    if (!isRecord(ref)) throw new Error(`task: ${where} body reference must be an object`)
    if (!nonEmpty(ref.sessionId)) throw new Error(`task: ${where} body reference session id must be a non-empty string`)
    if (!Number.isInteger(ref.seq) || ref.seq < 0) throw new Error(`task: ${where} body reference seq must be a non-negative integer`)
  }

  private resolveCapabilities(taskId: TaskId, manifest: TaskSnapshot['capabilities'][string]): void {
    this.task(taskId)
    this.value = { ...this.value, capabilities: { ...this.value.capabilities, [taskId]: copy(manifest) } }
  }

  private produceEvidence(taskId: TaskId, runId: RunId | undefined, evidence: TaskSnapshot['evidence'][number]): void {
    this.task(taskId)
    if (typeof evidence.evidenceId !== 'string' || evidence.evidenceId.length === 0) throw new Error('task: evidence id must be a non-empty string')
    if (this.value.evidence.some(item => item.evidenceId === evidence.evidenceId)) {
      throw new Error(`task: evidence "${evidence.evidenceId}" already exists`)
    }
    if (evidence.taskId !== taskId) throw new Error(`task: evidence "${evidence.evidenceId}" does not belong to task "${taskId}"`)
    const run = this.run(evidence.taskRunId)
    if (run.taskId !== taskId) throw new Error(`task: evidence "${evidence.evidenceId}" run "${run.runId}" belongs to task "${run.taskId}"`)
    if (runId !== undefined && runId !== evidence.taskRunId) throw new Error(`task: evidence "${evidence.evidenceId}" envelope run id mismatch`)
    if (run.status !== 'running') {
      throw new Error(`task: run "${run.runId}" is ${run.status}; evidence can only be recorded while the run is running`)
    }
    this.value = {
      ...this.value,
      evidence: [...this.value.evidence, copy(evidence)],
      runs: this.value.runs.map(item => item.runId === run.runId
        ? { ...item, artifacts: [...item.artifacts, ...copy(evidence.artifacts)], verifierResults: [...item.verifierResults, ...copy(evidence.verifierResults)] }
        : item),
    }
  }

  private addHandoff(handoff: TaskSnapshot['handoffs'][number]): void {
    if (typeof handoff.handoffId !== 'string' || handoff.handoffId.length === 0) throw new Error('task: handoff id must be a non-empty string')
    if (this.value.handoffs.some(item => item.handoffId === handoff.handoffId)) {
      throw new Error(`task: handoff "${handoff.handoffId}" already exists`)
    }
    const parent = this.task(handoff.parentTaskId)
    const child = this.task(handoff.childTaskId)
    if (child.parentTaskId !== parent.taskId) throw new Error(`task: handoff child "${child.taskId}" is not a child of "${parent.taskId}"`)
    this.run(handoff.parentRunId)
    this.value = { ...this.value, handoffs: [...this.value.handoffs, copy(handoff)] }
  }

  /**
   * A review is the legal companion of the terminal transition it follows: the
   * run (or the runless blocked task) must already sit in the outcome the record
   * declares, and each run accepts exactly one record — a second one is a bug in
   * the writer, not a late event to tolerate.
   */
  private recordReview(taskId: TaskId, envelopeRunId: RunId | undefined, review: ReviewRecord): void {
    const task = this.task(taskId)
    if (review.taskId !== taskId) throw new Error(`task: review for "${review.taskId}" does not belong to task "${taskId}"`)
    if (review.outcome === 'failed' && (typeof review.localizedCause !== 'string' || review.localizedCause.length === 0)) {
      throw new Error(`task: failed review for task "${taskId}" requires a localized cause`)
    }
    if (review.outcome !== 'failed' && review.localizedCause !== undefined) {
      throw new Error(`task: review for task "${taskId}" is ${review.outcome}; only a failed outcome carries a localized cause`)
    }
    if (review.outcome !== 'failed' && review.logTail !== undefined) {
      throw new Error(`task: review for task "${taskId}" is ${review.outcome}; only a failed outcome carries a log tail`)
    }
    if (review.outcome !== 'blocked' && review.blockedBy !== undefined) {
      throw new Error(`task: review for task "${taskId}" is ${review.outcome}; only a blocked outcome carries blockers`)
    }
    if (review.runId === undefined) {
      if (review.outcome !== 'blocked' || task.status !== 'blocked') {
        throw new Error(`task: review for task "${taskId}" has no run; only a blocked task settles without a run`)
      }
      if (this.value.reviews.some(item => item.taskId === taskId && item.runId === undefined)) {
        throw new Error(`task: task "${taskId}" already has a runless review`)
      }
    } else {
      const run = this.run(review.runId)
      if (run.taskId !== taskId) throw new Error(`task: review run "${run.runId}" belongs to task "${run.taskId}"`)
      if (envelopeRunId !== undefined && envelopeRunId !== review.runId) {
        throw new Error(`task: review for run "${review.runId}" envelope run id mismatch`)
      }
      if (run.status !== review.outcome) {
        throw new Error(`task: run "${run.runId}" is ${run.status}; a review must follow the terminal transition it declares (${review.outcome})`)
      }
      if (this.value.reviews.some(item => item.runId === review.runId)) {
        throw new Error(`task: run "${review.runId}" already has a review`)
      }
    }
    this.value = { ...this.value, reviews: [...this.value.reviews, copy(review)] }
  }

  /**
   * A diagnosis is caller-triggered, not lifecycle-bound: any existing task
   * accepts one at any time, and a task accumulates several. What the reducer
   * enforces is integrity, not timing — the id is unique across the store
   * (a repeat write is a bug, not an update), every field is present and
   * well-formed, the diagnosis rests on at least one evidence or review ref,
   * and every proposal names one of the nine frozen target types (§2.7.6).
   *
   * The two optional additions are checked the same way: `producedBy` must name
   * a known producer kind (and a non-empty session when it carries one), and
   * every `judgements` entry must name a judged dimension and a known verdict,
   * carry a rationale, and rest on at least one non-empty evidence ref — an
   * `unknown` verdict still cites the refs it considered, so a judgement that
   * cites nothing is rejected rather than stored.
   */
  private recordDiagnosis(taskId: TaskId, diagnosis: Diagnosis): void {
    this.task(taskId)
    if (!nonEmpty(diagnosis.diagnosisId)) throw new Error('task: diagnosis id must be a non-empty string')
    if (this.value.diagnoses.some(item => item.diagnosisId === diagnosis.diagnosisId)) {
      throw new Error(`task: diagnosis "${diagnosis.diagnosisId}" already exists`)
    }
    if (diagnosis.taskId !== taskId) throw new Error(`task: diagnosis for "${diagnosis.taskId}" does not belong to task "${taskId}"`)
    if (!nonEmpty(diagnosis.observedFailure)) throw new Error(`task: diagnosis "${diagnosis.diagnosisId}" requires an observed failure`)
    if (!nonEmpty(diagnosis.scope)) throw new Error(`task: diagnosis "${diagnosis.diagnosisId}" requires a scope`)
    if (!nonEmpty(diagnosis.localizedCause)) throw new Error(`task: diagnosis "${diagnosis.diagnosisId}" requires a localized cause`)
    if (!['high', 'medium', 'low'].includes(diagnosis.confidence)) {
      throw new Error(`task: diagnosis "${diagnosis.diagnosisId}" confidence must be high, medium, or low`)
    }
    if (!Array.isArray(diagnosis.evidenceRefs) || !Array.isArray(diagnosis.reviewRefs)
      || diagnosis.evidenceRefs.some(item => !nonEmpty(item)) || diagnosis.reviewRefs.some(item => !nonEmpty(item))) {
      throw new Error(`task: diagnosis "${diagnosis.diagnosisId}" refs must be arrays of non-empty strings`)
    }
    if (diagnosis.evidenceRefs.length + diagnosis.reviewRefs.length === 0) {
      throw new Error(`task: diagnosis "${diagnosis.diagnosisId}" must rest on at least one evidence or review ref`)
    }
    if (!Array.isArray(diagnosis.proposals)) throw new Error(`task: diagnosis "${diagnosis.diagnosisId}" proposals must be an array`)
    for (const proposal of diagnosis.proposals) {
      if (!PROPOSAL_TARGET_TYPES.includes(proposal.targetType)) {
        throw new Error(`task: diagnosis "${diagnosis.diagnosisId}" proposal target type must be one of ${PROPOSAL_TARGET_TYPES.join(', ')}`)
      }
      if (!nonEmpty(proposal.targetId) || !nonEmpty(proposal.rationale)) {
        throw new Error(`task: diagnosis "${diagnosis.diagnosisId}" proposal requires a target id and a rationale`)
      }
    }
    if (diagnosis.producedBy !== undefined) {
      const provenance = diagnosis.producedBy
      if (provenance.kind !== 'agent' && provenance.kind !== 'human') {
        throw new Error(`task: diagnosis "${diagnosis.diagnosisId}" producedBy.kind must be "agent" or "human"`)
      }
      if (provenance.sessionId !== undefined && !nonEmpty(provenance.sessionId)) {
        throw new Error(`task: diagnosis "${diagnosis.diagnosisId}" producedBy.sessionId must be a non-empty string`)
      }
    }
    if (diagnosis.judgements !== undefined) {
      if (!Array.isArray(diagnosis.judgements)) {
        throw new Error(`task: diagnosis "${diagnosis.diagnosisId}" judgements must be an array`)
      }
      for (const judgement of diagnosis.judgements) {
        if (!JUDGED_DIMENSIONS.includes(judgement.dimension)) {
          throw new Error(`task: diagnosis "${diagnosis.diagnosisId}" judgement dimension must be one of ${JUDGED_DIMENSIONS.join(', ')}`)
        }
        if (!JUDGEMENT_VERDICTS.includes(judgement.verdict)) {
          throw new Error(`task: diagnosis "${diagnosis.diagnosisId}" judgement verdict must be one of ${JUDGEMENT_VERDICTS.join(', ')}`)
        }
        if (!Array.isArray(judgement.evidenceRefs) || judgement.evidenceRefs.length === 0
          || judgement.evidenceRefs.some(item => !nonEmpty(item))) {
          throw new Error(`task: diagnosis "${diagnosis.diagnosisId}" judgement "${judgement.dimension}" must rest on at least one non-empty evidence ref`)
        }
        if (!nonEmpty(judgement.rationale)) {
          throw new Error(`task: diagnosis "${diagnosis.diagnosisId}" judgement "${judgement.dimension}" requires a rationale`)
        }
      }
    }
    for (const related of diagnosis.relatedTaskIds ?? []) this.task(related)
    this.value = { ...this.value, diagnoses: [...this.value.diagnoses, copy(diagnosis)] }
  }

  /**
   * An obligation is raised, never scheduled (KISS §5.1: a question, not an
   * action): the reducer enforces integrity only — a unique non-empty id,
   * non-empty goal and criterion, and a source task that exists in the store.
   */
  private recordObligation(obligation: Obligation): void {
    if (!nonEmpty(obligation.obligationId)) throw new Error('task: obligation id must be a non-empty string')
    if (this.value.obligations.some(item => item.obligationId === obligation.obligationId)) {
      throw new Error(`task: obligation "${obligation.obligationId}" already exists`)
    }
    if (!nonEmpty(obligation.goal)) throw new Error(`task: obligation "${obligation.obligationId}" requires a goal`)
    if (!nonEmpty(obligation.criterion)) throw new Error(`task: obligation "${obligation.obligationId}" requires a criterion`)
    this.task(obligation.sourceTaskId)
    this.value = { ...this.value, obligations: [...this.value.obligations, copy(obligation)] }
  }

  /**
   * A proposal enters the store (T2/T3, §6; root contracts A0 §2). The reducer
   * is the shape gate and the integrity gate, in that order: the record must be
   * a well-formed proposal of its kind — the closed field set of its review
   * context, a birth status matching the policy it was submitted under, an
   * identity and a payload whose digests are really the digests of what it
   * carries — and it must not collide with what the store already holds. One key
   * names one proposal and one content identity names one id, so a repeated
   * request can never build a second batch: the caller answers it from the index
   * instead.
   *
   * A root contract has one more gate, and it is the store's, not the record's:
   * a store that already holds a root task refuses root intake by name (A0 §1.6
   * — an old graph's root is history and is not re-intaken, and a goal change is
   * a new graph). The gate is checked here, before anything is stored, so an
   * intake on such a store leaves no trace at all.
   *
   * The digest checks are the point of the submission being an event at all: a
   * proposal whose `proposalDigest`, `admissionContextDigest` or
   * `reviewContextDigest` disagrees with the content it carries would make the
   * approval binding meaningless, because a later decision compares exactly
   * these numbers.
   */
  private submitProposal(taskId: TaskId, proposal: TaskProposal): void {
    this.assertProposal(proposal)
    this.assertProposalTask(proposal, taskId)
    const index = this.index()
    if (index.byId[proposal.proposalId] !== undefined) {
      throw new Error(`task: proposal "${proposal.proposalId}" already exists`)
    }
    const bound = index.byRequestKey[proposal.requestKey]
    if (bound !== undefined) {
      throw new Error(`task: proposal request key "${proposal.requestKey}" is already bound to proposal "${bound.proposalId}"`)
    }
    if (proposal.kind === 'root') this.assertRootIntakeOpen(proposal.proposalId)
    const stored: TaskProposal = copy(proposal)
    if (stored.kind === 'root') {
      // A root contract belongs to no task: it is in the index by id and by
      // request key, and in no parent's list.
      this.value = {
        ...this.value,
        proposals: {
          all: [...index.all, stored],
          byId: { ...index.byId, [stored.proposalId]: stored },
          byRequestKey: { ...index.byRequestKey, [stored.requestKey]: stored },
          byParentTask: index.byParentTask,
        },
      }
      return
    }
    const parentTaskId = stored.identity.parentTaskId
    this.value = {
      ...this.value,
      proposals: {
        all: [...index.all, stored],
        byId: { ...index.byId, [stored.proposalId]: stored },
        byRequestKey: { ...index.byRequestKey, [stored.requestKey]: stored },
        byParentTask: {
          ...index.byParentTask,
          [parentTaskId]: [...(index.byParentTask[parentTaskId] ?? []), stored],
        },
      },
    }
  }

  /**
   * One review decision (T2/T3, §6): the outcome, bound to the dossier digest
   * and both context fingerprints, checked against the stored proposal before
   * anything is applied. A digest that disagrees is refused by name — an
   * approval that does not name exactly this batch, under exactly these limits
   * and exactly this resolution, is not an approval of it — and an outcome that
   * is not legal from the current status is refused as a transition, so a
   * second decision never overwrites the first and a policy-off proposal can
   * never be recorded as reviewed.
   */
  private decideProposal(taskId: TaskId, claim: TaskProposalDecisionClaim, timestamp: string): void {
    if (!isRecord(claim)) throw new Error('task: proposal decision must be an object')
    const proposal = this.proposal(claim.proposalId)
    this.assertProposalTask(proposal, taskId)
    if (!TASK_PROPOSAL_DECISION_OUTCOMES.includes(claim.outcome)) {
      throw new Error(
        `task: proposal "${proposal.proposalId}" decision outcome must be one of ${TASK_PROPOSAL_DECISION_OUTCOMES.join(', ')}`,
      )
    }
    this.assertDecisionBinding(proposal, claim)
    if (!nonEmpty(claim.decidedBy)) throw new Error(`task: proposal "${proposal.proposalId}" decision requires a decider`)
    if (!nonEmpty(claim.decidedAt)) throw new Error(`task: proposal "${proposal.proposalId}" decision requires a decision time`)
    if (claim.reason !== undefined && !nonEmpty(claim.reason)) {
      throw new Error(`task: proposal "${proposal.proposalId}" decision reason must be a non-empty string when present`)
    }
    if (claim.outcome === 'expired' && !nonEmpty(claim.reason)) {
      throw new Error(`task: proposal "${proposal.proposalId}" expiry requires a reason`)
    }
    this.assertProposalTransition(proposal, claim.outcome, DECISION_SOURCES[claim.outcome])
    this.setProposal(proposal.proposalId, {
      status: claim.outcome,
      updatedAt: timestamp,
      decision: {
        outcome: claim.outcome,
        proposalDigest: claim.proposalDigest,
        admissionContextDigest: claim.admissionContextDigest,
        ...(claim.reviewContextDigest === undefined ? {} : { reviewContextDigest: claim.reviewContextDigest }),
        decidedBy: claim.decidedBy,
        decidedAt: claim.decidedAt,
        ...(claim.reason === undefined ? {} : { reason: claim.reason }),
      },
    })
  }

  /**
   * One runtime phase change (T2/T3, §6): the two edges that are not a person's
   * decision or a consumption — `ready → pending_review` when the deployment
   * tightened to `all` before admission, `approved → ready` when the
   * post-approval re-check passed, and `→ stale` when it failed. The source
   * statuses are the gate (see {@link PHASE_SOURCES}), and a `stale` marking
   * must name what changed: an invalidation a reader cannot explain is a
   * record that cannot be trusted.
   */
  private changeProposalPhase(taskId: TaskId, change: TaskProposalPhaseChange, timestamp: string): void {
    if (!isRecord(change)) throw new Error('task: proposal phase change must be an object')
    const proposal = this.proposal(change.proposalId)
    this.assertProposalTask(proposal, taskId)
    if (!TASK_PROPOSAL_PHASES.includes(change.to)) {
      throw new Error(`task: proposal "${proposal.proposalId}" phase must be one of ${TASK_PROPOSAL_PHASES.join(', ')}`)
    }
    if (change.to === 'stale' && !nonEmpty(change.reason)) {
      throw new Error(`task: proposal "${proposal.proposalId}" is marked stale without a reason`)
    }
    if (change.reason !== undefined && !nonEmpty(change.reason)) {
      throw new Error(`task: proposal "${proposal.proposalId}" phase change reason must be a non-empty string when present`)
    }
    this.assertProposalTransition(proposal, change.to, PHASE_SOURCES[change.to])
    this.setProposal(proposal.proposalId, { status: change.to, updatedAt: timestamp })
  }

  /**
   * A proposal is consumed (§6): what it asked for exists, and this record says
   * what it became. The status gate is the re-check having passed on the record
   * (`ready` only — an approval alone never admits, so `approved → admitted` is
   * refused), and the binding is checked in full for the proposal's kind: a
   * decomposition batch names the parent run and the derived batch id of its
   * identity, plus children the store holds under that parent; a root contract
   * names the root task and root run of its activation, and the store refuses
   * one intake that would leave it with two roots. A second consumption is a
   * transition refusal, so one proposal can never produce two batches — or two
   * roots.
   */
  private admitProposal(taskId: TaskId, consumption: TaskProposalConsumption, timestamp: string): void {
    if (!isRecord(consumption)) throw new Error('task: proposal consumption must be an object')
    const proposal = this.proposal(consumption.proposalId)
    this.assertProposalTask(proposal, taskId)
    this.assertConsumptionBinding(proposal, consumption)
    this.assertProposalTransition(proposal, 'admitted', ADMISSION_SOURCES)
    this.setProposal(proposal.proposalId, {
      status: 'admitted',
      updatedAt: timestamp,
      consumption: consumption.kind === 'root'
        ? {
            kind: 'root',
            proposalId: consumption.proposalId,
            proposalDigest: consumption.proposalDigest,
            reviewContextDigest: consumption.reviewContextDigest,
            rootTaskId: consumption.rootTaskId,
            rootRunId: consumption.rootRunId,
            admittedAt: consumption.admittedAt,
            ...(consumption.reason === undefined ? {} : { reason: consumption.reason }),
          }
        : {
            ...(consumption.kind === undefined ? {} : { kind: consumption.kind }),
            proposalId: consumption.proposalId,
            proposalDigest: consumption.proposalDigest,
            reviewContextDigest: consumption.reviewContextDigest,
            parentRunId: consumption.parentRunId,
            batchId: consumption.batchId,
            childTaskIds: [...consumption.childTaskIds],
            admittedAt: consumption.admittedAt,
            ...(consumption.reason === undefined ? {} : { reason: consumption.reason }),
          },
    })
  }

  /** The stored proposal one event names, or a refusal naming the id. */
  private proposal(proposalId: string): TaskProposal {
    const proposal = this.index().byId[proposalId]
    if (proposal === undefined) throw new Error(`task: unknown proposal "${String(proposalId)}"`)
    return proposal
  }

  /**
   * The proposal index of the snapshot this state replays on. It is absent only
   * when a foreign snapshot (a hand-built one from a reader that predates
   * proposals) was replayed onto — never on this build's own value — and that
   * is a refusal rather than an empty index: a reducer that cannot see the
   * proposals would happily write a second one for the same request key.
   */
  private index(): TaskProposalIndex {
    const index = this.value.proposals
    if (index === undefined) throw new Error('task: snapshot carries no proposal index')
    return index
  }

  /**
   * The question index of the snapshot this state replays on. Absent only when
   * a foreign, hand-built snapshot (one from a reader that predates questions)
   * was replayed onto — never on this build's own value — and that is a refusal
   * rather than an empty index, for the same reason as {@link index}: a reducer
   * that cannot see the questions would happily write a second one for the same
   * (run, request key) identity.
   */
  private questions(): TaskQuestionIndex {
    const index = this.value.questions
    if (index === undefined) throw new Error('task: snapshot carries no question index')
    return index
  }

  /**
   * Every proposal event is about one subject, and the envelope has to name it:
   * a decomposition proposal's events name the parent task whose batch it is; a
   * root contract's events name the reserved {@link ROOT_PROPOSAL_TASK_ID}
   * marker, because the task it becomes does not exist yet and naming a real
   * task would read as that task's intake (A0 §2).
   */
  private assertProposalTask(proposal: TaskProposal, taskId: TaskId): void {
    if (proposal.kind === 'root') {
      if (taskId !== ROOT_PROPOSAL_TASK_ID) {
        throw new Error(
          `task: proposal "${proposal.proposalId}" is a root contract; its events must carry the reserved proposal task id "${ROOT_PROPOSAL_TASK_ID}", not "${taskId}"`,
        )
      }
      return
    }
    if (taskId !== proposal.identity.parentTaskId) {
      throw new Error(`task: proposal "${proposal.proposalId}" belongs to task "${proposal.identity.parentTaskId}", not "${taskId}"`)
    }
  }

  /** The store's root task, if it has one: the task a root intake may not sit beside or activate a second time. */
  private rootTask(): TaskInstance | undefined {
    return this.value.tasks.find(item => item.parentTaskId === undefined)
  }

  /**
   * A store with a root task refuses root intake by name (A0 §1.6): the root it
   * holds is somebody's goal, and a second intake would make "the store's root"
   * answer differently at two reads. A goal change is a new graph, never a
   * second root here.
   */
  private assertRootIntakeOpen(proposalId: string): void {
    const root = this.rootTask()
    if (root !== undefined) {
      throw new Error(`task: store "${this.value.id}" already holds root task "${root.taskId}"; proposal "${proposalId}" is refused`)
    }
  }

  /** One proposal's status either admits this outcome or the event is a late or out-of-order write. */
  private assertProposalTransition(proposal: TaskProposal, to: TaskProposalStatus, from: readonly TaskProposalStatus[]): void {
    if (!from.includes(proposal.status)) {
      throw new Error(`task: illegal proposal transition "${proposal.status}" → "${to}" for proposal "${proposal.proposalId}"`)
    }
  }

  /** Replaces one proposal in place; the index's other views keep pointing at the same record. */
  private setProposal(proposalId: string, patch: Partial<TaskProposalBase>): void {
    const index = this.index()
    const current = index.byId[proposalId]
    if (current === undefined) throw new Error(`task: unknown proposal "${proposalId}"`)
    const next: TaskProposal = { ...current, ...patch }
    const replace = (proposals: readonly TaskProposal[]): TaskProposal[] =>
      proposals.map(item => (item.proposalId === proposalId ? next : item))
    this.value = {
      ...this.value,
      proposals: {
        all: replace(index.all),
        byId: { ...index.byId, [proposalId]: next },
        byRequestKey: { ...index.byRequestKey, [next.requestKey]: next },
        byParentTask: Object.fromEntries(
          Object.entries(index.byParentTask).map(([parentTaskId, proposals]) => [parentTaskId, replace(proposals)]),
        ),
      },
    }
  }

  /**
   * A submitted proposal has to be complete and internally consistent, because
   * everything an approval binds is taken from it: the review context is a
   * closed record (an unread field would silently become part of an identity),
   * the birth status is the policy the deployment ran under (`off → ready`,
   * `all → pending_review` — the audit of "no human review happened" depends on
   * it), a revision must name a proposal that exists, and the three digests
   * must be the digests of the data they claim to describe.
   */
  private assertProposal(proposal: TaskProposal): void {
    if (!isRecord(proposal)) throw new Error('task: proposal must be an object')
    if (!nonEmpty(proposal.proposalId)) throw new Error('task: proposal id must be a non-empty string')
    const id = proposal.proposalId
    if (!nonEmpty(proposal.requestKey)) throw new Error(`task: proposal "${id}" request key must be a non-empty string`)
    const kind: unknown = (proposal as { kind?: unknown }).kind
    if (kind !== undefined && kind !== 'decomposition' && kind !== 'root') {
      throw new Error(`task: proposal "${id}" kind must be one of ${TASK_PROPOSAL_KINDS.join(', ')}`)
    }
    if (kind === undefined && this.carriesRootContract(proposal)) {
      throw new Error(`task: proposal "${id}" carries root contract fields without kind "root"`)
    }
    if (proposal.status !== 'ready' && proposal.status !== 'pending_review') {
      throw new Error(`task: proposal "${id}" status "${String(proposal.status)}" is not a birth status`)
    }
    if (proposal.policy !== 'off' && proposal.policy !== 'all') {
      throw new Error(`task: proposal "${id}" policy must be "off" or "all"`)
    }
    if (proposal.status === 'ready' && proposal.policy === 'all') {
      throw new Error(`task: proposal "${id}" is submitted ready with policy "all"`)
    }
    if (proposal.status === 'pending_review' && proposal.policy === 'off') {
      throw new Error(`task: proposal "${id}" is submitted pending_review with policy "off"`)
    }
    if (proposal.supersedes !== undefined) {
      if (!nonEmpty(proposal.supersedes)) throw new Error(`task: proposal "${id}" supersedes must be a non-empty proposal id`)
      if (proposal.supersedes === id) throw new Error(`task: proposal "${id}" cannot supersede itself`)
      if (this.index().byId[proposal.supersedes] === undefined) {
        throw new Error(`task: proposal "${id}" supersedes unknown proposal "${proposal.supersedes}"`)
      }
    }
    if (proposal.kind === 'root') {
      this.assertRootProposal(id, proposal)
    } else {
      this.assertDecompositionProposal(id, proposal)
    }
    const context = proposal.admissionContext
    if (!isRecord(context)) throw new Error(`task: proposal "${id}" requires an admission context`)
    this.assertAdmissionLimits(`proposal "${id}" admission context`, context)
    const contextDigest = admissionContextDigest(proposal.admissionContext)
    if (proposal.admissionContextDigest !== contextDigest) {
      throw new Error(
        `task: proposal "${id}" admission context digest "${String(proposal.admissionContextDigest)}" does not match its context digest "${contextDigest}"`,
      )
    }
    this.assertReviewContext(id, proposal.reviewContext)
    const reviewDigest = reviewContextDigest(proposal.reviewContext)
    if (proposal.reviewContextDigest !== reviewDigest) {
      throw new Error(
        `task: proposal "${id}" review context digest "${String(proposal.reviewContextDigest)}" does not match its context digest "${reviewDigest}"`,
      )
    }
    if (!nonEmpty(proposal.createdAt)) throw new Error(`task: proposal "${id}" requires a creation time`)
    if (proposal.decision !== undefined) throw new Error(`task: proposal "${id}" is submitted with a decision`)
    if (proposal.consumption !== undefined) throw new Error(`task: proposal "${id}" is submitted with a consumption`)
  }

  /**
   * A decomposition proposal's half of the record: the batch identity and the
   * batch content that must be the content of that identity. Both digests are
   * the ones they always were — this arm is the shape T2/T3 shipped, and adding
   * a kind to the union does not move its identity.
   */
  private assertDecompositionProposal(id: string, proposal: TaskProposalDecomposition): void {
    if ((proposal as { contract?: unknown }).contract !== undefined) {
      throw new Error(`task: proposal "${id}" is a decomposition proposal and cannot carry a root contract`)
    }
    this.assertProposalIdentity(id, proposal.identity)
    this.assertProposalBatch(id, proposal.batch, proposal.identity)
    const expected = decompositionDigest(proposal.identity)
    if (proposal.proposalDigest !== expected) {
      throw new Error(`task: proposal "${id}" proposal digest "${String(proposal.proposalDigest)}" does not match its identity digest "${expected}"`)
    }
  }

  /**
   * A root contract proposal's half of the record: the root identity (store,
   * root session, request key, contract digest — and no parent task) and the one
   * normalized contract it must be the digest of. The two shapes are checked
   * before the digest, so a mismatch is reported as the wrong content rather
   * than as a wrong number.
   */
  private assertRootProposal(id: string, proposal: TaskProposalRoot): void {
    if ((proposal as { batch?: unknown }).batch !== undefined) {
      throw new Error(`task: proposal "${id}" is a root contract and cannot carry a batch`)
    }
    this.assertRootIdentity(id, proposal.identity)
    if (proposal.identity.requestKey !== proposal.requestKey) {
      throw new Error(
        `task: proposal "${id}" identity request key "${proposal.identity.requestKey}" disagrees with its request key "${proposal.requestKey}"`,
      )
    }
    const contract: unknown = proposal.contract
    if (!isRecord(contract)) throw new Error(`task: proposal "${id}" requires a root contract`)
    this.assertContractFields(`proposal "${id}" root`, contract as unknown as TaskContract)
    if (!Array.isArray((contract as unknown as TaskContract).acceptanceCriteria)) {
      throw new Error(`task: proposal "${id}" root contract acceptance criteria must be an array`)
    }
    const digest = contractDigest(contract as unknown as TaskContract)
    if (digest !== proposal.identity.contractDigest) {
      throw new Error(
        `task: proposal "${id}" contract digest "${digest}" does not match its identity digest "${proposal.identity.contractDigest}"`,
      )
    }
    const expected = rootProposalDigest(proposal.identity)
    if (proposal.proposalDigest !== expected) {
      throw new Error(`task: proposal "${id}" proposal digest "${String(proposal.proposalDigest)}" does not match its identity digest "${expected}"`)
    }
  }

  /**
   * Whether a record that does not claim `kind: 'root'` still carries a root
   * contract's fields. Absence of the kind is legal for exactly one arm, so a
   * record that holds a root payload without saying so is refused instead of
   * being read as a decomposition of a parent that does not exist.
   */
  private carriesRootContract(proposal: TaskProposal): boolean {
    const raw = proposal as unknown as { contract?: unknown; identity?: unknown }
    if (raw.contract !== undefined) return true
    const identity: unknown = raw.identity
    return isRecord(identity) && identity.rootSessionId !== undefined
  }

  /**
   * The batch identity a proposal carries, judged for shape only: the field
   * semantics (a version this build knows, non-empty origins, one dependency
   * index per child) are what a reader needs to interpret it, while the
   * *rules* about a batch — depth, size, dependency cycles, capability gaps —
   * belong to the admission entry that already enforces them (T1's
   * `contractDefects` and the runtime's `checkDecomposition`). The parent task
   * is the one exception, because a proposal naming a task the store does not
   * hold could never be decided or admitted against a real parent. The field set
   * is closed, like every other surface a digest covers: a field no reader
   * understands must not travel inside an identity that a decision binds.
   */
  private assertProposalIdentity(id: string, identity: DecompositionIdentity): void {
    if (!isRecord(identity)) throw new Error(`task: proposal "${id}" identity must be an object`)
    for (const key of Object.keys(identity)) {
      if (!DECOMPOSITION_IDENTITY_FIELDS.includes(key)) {
        throw new Error(`task: proposal "${id}" identity has an unsupported field "${key}"`)
      }
    }
    if (identity.contractVersion !== TASK_CONTRACT_VERSION) {
      throw new Error(`task: proposal "${id}" declares contract version ${String(identity.contractVersion)}; this build stores version ${TASK_CONTRACT_VERSION}`)
    }
    const names: ReadonlyArray<readonly [string, unknown]> = [
      ['store id', identity.storeId],
      ['parent run id', identity.parentRunId],
      ['caller session id', identity.callerSessionId],
    ]
    for (const [name, value] of names) {
      if (!nonEmpty(value)) throw new Error(`task: proposal "${id}" identity ${name} must be a non-empty string`)
    }
    if (!nonEmpty(identity.parentTaskId)) {
      throw new Error(`task: proposal "${id}" identity parent task id must be a non-empty string`)
    }
    if (typeof identity.reason !== 'string') throw new Error(`task: proposal "${id}" identity reason must be a string`)
    if (!Array.isArray(identity.children) || identity.children.length === 0) {
      throw new Error(`task: proposal "${id}" identity requires at least one child`)
    }
    identity.children.forEach((child, index) => {
      if (!isRecord(child)) throw new Error(`task: proposal "${id}" child ${index} must be an object`)
      if (!isDigest(child.contractDigest)) {
        throw new Error(`task: proposal "${id}" child ${index} contract digest must be a lowercase SHA-256 hex digest`)
      }
      if (!Array.isArray(child.dependsOn) || child.dependsOn.some(item => !Number.isInteger(item) || item < 0)) {
        throw new Error(`task: proposal "${id}" child ${index} dependsOn must be an array of non-negative integers`)
      }
      if (typeof child.decomposable !== 'boolean') {
        throw new Error(`task: proposal "${id}" child ${index} decomposable must be a boolean`)
      }
      if (typeof child.requiresIndependentAcceptance !== 'boolean') {
        throw new Error(`task: proposal "${id}" child ${index} requiresIndependentAcceptance must be a boolean`)
      }
    })
    if (!this.value.tasks.some(item => item.taskId === identity.parentTaskId)) {
      throw new Error(`task: proposal "${id}" names unknown parent task "${identity.parentTaskId}"`)
    }
  }

  /**
   * The root identity a root contract carries, judged for shape only: the
   * version of the contract language, the store and root session it is for, its
   * request key and the digest of the contract beside it. Its field set is
   * closed — a root contract has no parent task or parent run, so a record that
   * carries one is refused rather than read as something it is not — and nothing
   * about the store's tasks is checked here: a root intake names no task, and its
   * one store-level gate (the store does not already hold a root) belongs to the
   * submission, not to the identity.
   */
  private assertRootIdentity(id: string, identity: RootProposalIdentity): void {
    if (!isRecord(identity)) throw new Error(`task: proposal "${id}" identity must be an object`)
    for (const key of Object.keys(identity)) {
      if (!ROOT_IDENTITY_FIELDS.includes(key)) {
        throw new Error(`task: proposal "${id}" identity has an unsupported field "${key}"`)
      }
    }
    if (identity.contractVersion !== TASK_CONTRACT_VERSION) {
      throw new Error(`task: proposal "${id}" declares contract version ${String(identity.contractVersion)}; this build stores version ${TASK_CONTRACT_VERSION}`)
    }
    const names: ReadonlyArray<readonly [string, unknown]> = [
      ['store id', identity.storeId],
      ['root session id', identity.rootSessionId],
      ['request key', identity.requestKey],
    ]
    for (const [name, value] of names) {
      if (!nonEmpty(value)) throw new Error(`task: proposal "${id}" identity ${name} must be a non-empty string`)
    }
    if (!isDigest(identity.contractDigest)) {
      throw new Error(`task: proposal "${id}" identity contract digest must be a lowercase SHA-256 hex digest`)
    }
  }

  /**
   * The batch content a submission carries, bound to the identity it claims to
   * be: one child per identity child, in the same order, each carrying the
   * contract whose {@link contractDigest} is the identity's child digest and the
   * three declarations the identity records. This is the reference constraint
   * that keeps a proposal from being a set of digests with no content behind
   * them — or content nobody committed to — and it is what makes "the batch a
   * reviewer was shown", "the batch an approval binds" and "the batch the
   * identity commits to" one thing rather than three.
   *
   * The content is judged for shape here (a closed field set per child, a
   * contract this build can read, a dependency list of indices, the two flags),
   * and for agreement with the identity in every field. Whether the *rules* of a
   * batch hold — depth, size, cycles, capability gaps — is the admission
   * entry's business, unchanged.
   */
  private assertProposalBatch(id: string, batch: readonly TaskProposalChild[], identity: DecompositionIdentity): void {
    if (!Array.isArray(batch)) throw new Error(`task: proposal "${id}" batch must be an array`)
    if (batch.length !== identity.children.length) {
      throw new Error(
        `task: proposal "${id}" batch requires one child per identity child (identity children: ${identity.children.length}, batch children: ${batch.length})`,
      )
    }
    batch.forEach((child, index) => {
      const where = `proposal "${id}" child ${index}`
      const identityChild = identity.children[index]!
      if (!isRecord(child)) throw new Error(`task: ${where} must be an object`)
      for (const key of Object.keys(child)) {
        if (!PROPOSAL_CHILD_FIELDS.includes(key)) throw new Error(`task: ${where} has an unsupported field "${key}"`)
      }
      const contract: unknown = child.contract
      if (!isRecord(contract)) throw new Error(`task: ${where} requires a contract`)
      this.assertContractFields(where, contract as unknown as TaskContract)
      if (!Array.isArray(child.dependsOn) || child.dependsOn.some(item => !Number.isInteger(item) || item < 0)) {
        throw new Error(`task: ${where} dependsOn must be an array of non-negative integers`)
      }
      if (typeof child.decomposable !== 'boolean') throw new Error(`task: ${where} decomposable must be a boolean`)
      if (typeof child.requiresIndependentAcceptance !== 'boolean') {
        throw new Error(`task: ${where} requiresIndependentAcceptance must be a boolean`)
      }
      const digest = contractDigest(contract as unknown as TaskContract)
      if (digest !== identityChild.contractDigest) {
        throw new Error(
          `task: ${where} contract digest "${digest}" does not match its identity digest "${identityChild.contractDigest}"`,
        )
      }
      const sameDepends =
        child.dependsOn.length === identityChild.dependsOn.length
        && child.dependsOn.every((value, position) => value === identityChild.dependsOn[position])
      if (!sameDepends) throw new Error(`task: ${where} dependsOn does not match its identity`)
      if (child.decomposable !== identityChild.decomposable) {
        throw new Error(`task: ${where} decomposable does not match its identity`)
      }
      if (child.requiresIndependentAcceptance !== identityChild.requiresIndependentAcceptance) {
        throw new Error(`task: ${where} requiresIndependentAcceptance does not match its identity`)
      }
    })
  }

  /**
   * A decision binds the proposal it was made against, so every identity it
   * carries is compared with the stored record: the dossier digest, the
   * admission context, and — for an approval, always — the review context the
   * batch resolved against when it was shown. A mismatch is the one case the
   * reducer must never accept: an approval that travels to other content is
   * exactly the failure the digest binding exists to prevent.
   */
  private assertDecisionBinding(proposal: TaskProposal, claim: TaskProposalDecisionClaim): void {
    if (claim.proposalDigest !== proposal.proposalDigest) {
      throw new Error(
        `task: proposal "${proposal.proposalId}" decision digest "${String(claim.proposalDigest)}" does not match the stored proposal digest "${proposal.proposalDigest}"`,
      )
    }
    if (claim.admissionContextDigest !== proposal.admissionContextDigest) {
      throw new Error(
        `task: proposal "${proposal.proposalId}" decision admission context digest "${String(claim.admissionContextDigest)}" does not match the stored admission context digest "${proposal.admissionContextDigest}"`,
      )
    }
    if (claim.outcome === 'approved' && claim.reviewContextDigest === undefined) {
      throw new Error(`task: proposal "${proposal.proposalId}" approval requires the review context digest it was decided against`)
    }
    if (claim.reviewContextDigest !== undefined && claim.reviewContextDigest !== proposal.reviewContextDigest) {
      throw new Error(
        `task: proposal "${proposal.proposalId}" decision review context digest "${claim.reviewContextDigest}" does not match the stored review context digest "${proposal.reviewContextDigest}"`,
      )
    }
  }

  /**
   * A consumption binds a proposal to what it became, so it has to name the same
   * dossier and the resolution the admission re-check confirmed — for both kinds
   * — and then the kind's own shape: a batch names the parent run of its
   * identity, the batch id that pair derives
   * (`b-<parentRunId>-<proposalId>`) and children the store really holds under
   * that parent; a root contract names the root task and root run of its
   * activation. The common half is checked here so the two kinds cannot drift
   * apart on the numbers that make an approval non-transferable.
   */
  private assertConsumptionBinding(proposal: TaskProposal, consumption: TaskProposalConsumption): void {
    const id = proposal.proposalId
    if (consumption.proposalDigest !== proposal.proposalDigest) {
      throw new Error(
        `task: proposal "${id}" consumption digest "${String(consumption.proposalDigest)}" does not match the stored proposal digest "${proposal.proposalDigest}"`,
      )
    }
    if (!nonEmpty(consumption.reviewContextDigest)) {
      throw new Error(`task: proposal "${id}" consumption requires a review context digest`)
    }
    if (consumption.reviewContextDigest !== proposal.reviewContextDigest) {
      throw new Error(
        `task: proposal "${id}" consumption review context digest "${consumption.reviewContextDigest}" does not match the stored review context digest "${proposal.reviewContextDigest}"`,
      )
    }
    if (proposal.kind === 'root') {
      this.assertRootConsumptionShape(proposal, consumption)
    } else {
      this.assertBatchConsumptionShape(proposal, consumption)
    }
    if (!nonEmpty(consumption.admittedAt)) throw new Error(`task: proposal "${id}" consumption requires an admission time`)
    if (consumption.reason !== undefined && !nonEmpty(consumption.reason)) {
      throw new Error(`task: proposal "${id}" consumption reason must be a non-empty string when present`)
    }
  }

  /**
   * The batch half of a consumption: the batch this run admitted, and children
   * the store really holds under the proposal's parent — the record a crash
   * recovery reads to find the batch it already admitted instead of admitting a
   * second one. The batch vocabulary is the only one this arm may use, its
   * `kind` may only be absent (a record written before kinds existed) or
   * `batch`, and its identity is the pair the batch is named by: the parent run
   * the proposal's identity names, and the id that pair derives
   * ({@link batchIdFor}).
   *
   * A consumption written before batches had that identity names none of it
   * (its `batchId` was `b-<parentTaskId>`) and is refused by name, not guessed
   * at: the store has no way to tell which run admitted it or which proposal it
   * was, and inventing either would hand a later reader a batch that is not the
   * one the record describes (see
   * `docs/persistence-changes/2026-09-26-k1-multi-batch.md`).
   */
  private assertBatchConsumptionShape(proposal: TaskProposalDecomposition, consumption: TaskProposalConsumption): void {
    const id = proposal.proposalId
    if (consumption.kind === 'root') {
      throw new Error(`task: proposal "${id}" is a decomposition proposal and cannot be consumed as a root contract`)
    }
    if (consumption.kind !== undefined && consumption.kind !== 'batch') {
      throw new Error(`task: proposal "${id}" consumption kind must be "batch"`)
    }
    const raw = consumption as unknown as Record<string, unknown>
    for (const field of ROOT_CONSUMPTION_FIELDS) {
      if (raw[field] !== undefined) {
        throw new Error(`task: proposal "${id}" consumption carries the root field "${field}"; a batch consumption names batchId and childTaskIds`)
      }
    }
    const batch = consumption as TaskProposalBatchConsumption
    if (!nonEmpty(batch.parentRunId)) {
      throw new Error(
        `task: proposal "${id}" consumption requires the parent run its batch belongs to; a consumption from before batches were identified by run and proposal is refused, not guessed at`,
      )
    }
    if (batch.parentRunId !== proposal.identity.parentRunId) {
      throw new Error(
        `task: proposal "${id}" consumption names parent run "${batch.parentRunId}", not the run "${proposal.identity.parentRunId}" its identity names`,
      )
    }
    if (!nonEmpty(batch.batchId)) throw new Error(`task: proposal "${id}" consumption requires a batch id`)
    const batchId = batchIdFor(proposal.identity.parentRunId, id)
    if (batch.batchId !== batchId) {
      throw new Error(
        `task: proposal "${id}" consumption batch "${batch.batchId}" is not the batch of run "${proposal.identity.parentRunId}" and proposal "${id}" ("${batchId}")`,
      )
    }
    if (!Array.isArray(batch.childTaskIds) || batch.childTaskIds.length === 0) {
      throw new Error(`task: proposal "${id}" consumption requires at least one child task id`)
    }
    for (const childTaskId of batch.childTaskIds) {
      if (!nonEmpty(childTaskId)) throw new Error(`task: proposal "${id}" consumption child task ids must be non-empty strings`)
    }
    const seen = new Set<TaskId>()
    for (const childTaskId of batch.childTaskIds) {
      if (seen.has(childTaskId)) throw new Error(`task: proposal "${id}" consumption names task "${childTaskId}" twice`)
      seen.add(childTaskId)
    }
    for (const childTaskId of batch.childTaskIds) {
      const child = this.value.tasks.find(item => item.taskId === childTaskId)
      if (child === undefined) throw new Error(`task: proposal "${id}" consumption names unknown task "${childTaskId}"`)
      if (child.parentTaskId !== proposal.identity.parentTaskId) {
        throw new Error(
          `task: proposal "${id}" consumption names task "${childTaskId}", which is not a child of "${proposal.identity.parentTaskId}"`,
        )
      }
    }
  }

  /**
   * The root half of a consumption: the root task and the root run the
   * activation minted, and the store's one-root rule. Every check is a way the
   * record could name something other than "the root this contract became":
   *
   * - the root task must exist and be parentless (a child is not a root), and it
   *   must be the store's *only* parentless task — the store refuses a second
   *   root, so a consumption that would leave it with two is refused as the one
   *   intake that tried to mint a second root (A0 §2: one consumption, one root);
   * - it must carry the contract the proposal committed to, so "what was
   *   approved" and "what was created" are one thing rather than two;
   * - the run must exist, belong to that task, be born `active` and running, and
   *   be in the proposal's root session — a root run is the root session's own
   *   execution, so a run of another session or one already settled is not it.
   */
  private assertRootConsumptionShape(proposal: TaskProposalRoot, consumption: TaskProposalConsumption): void {
    const id = proposal.proposalId
    if (consumption.kind !== 'root') {
      throw new Error(`task: proposal "${id}" consumption must declare kind "root"`)
    }
    const raw = consumption as unknown as Record<string, unknown>
    for (const field of BATCH_CONSUMPTION_FIELDS) {
      if (raw[field] !== undefined) {
        throw new Error(`task: proposal "${id}" consumption carries the batch field "${field}"; a root consumption names rootTaskId and rootRunId`)
      }
    }
    const root = consumption as TaskProposalRootConsumption
    if (!nonEmpty(root.rootTaskId)) throw new Error(`task: proposal "${id}" consumption requires a root task id`)
    if (!nonEmpty(root.rootRunId)) throw new Error(`task: proposal "${id}" consumption requires a root run id`)
    const task = this.value.tasks.find(item => item.taskId === root.rootTaskId)
    if (task === undefined) throw new Error(`task: proposal "${id}" consumption names unknown task "${root.rootTaskId}"`)
    if (task.parentTaskId !== undefined) {
      throw new Error(`task: proposal "${id}" consumption names task "${root.rootTaskId}", which is not a root task`)
    }
    const rival = this.value.tasks.find(item => item.parentTaskId === undefined && item.taskId !== root.rootTaskId)
    if (rival !== undefined) {
      throw new Error(
        `task: proposal "${id}" consumption names root task "${root.rootTaskId}" but store "${this.value.id}" already holds root task "${rival.taskId}"`,
      )
    }
    const contract: TaskContract | undefined = task.contract
    if (contract === undefined) {
      throw new Error(`task: proposal "${id}" consumption names root task "${root.rootTaskId}" without the contract the proposal committed to`)
    }
    const digest = contractDigest(contract)
    if (digest !== proposal.identity.contractDigest) {
      throw new Error(
        `task: proposal "${id}" consumption names root task "${root.rootTaskId}" whose contract digest "${digest}" is not the committed "${proposal.identity.contractDigest}"`,
      )
    }
    const run = this.value.runs.find(item => item.runId === root.rootRunId)
    if (run === undefined) throw new Error(`task: proposal "${id}" consumption names unknown run "${root.rootRunId}"`)
    if (run.taskId !== root.rootTaskId) {
      throw new Error(`task: proposal "${id}" consumption names run "${root.rootRunId}", which belongs to task "${run.taskId}"`)
    }
    if (run.sessionId !== proposal.identity.rootSessionId) {
      throw new Error(
        `task: proposal "${id}" consumption names run "${root.rootRunId}" of session "${run.sessionId}", not the root session "${proposal.identity.rootSessionId}"`,
      )
    }
    if (run.status !== 'running') {
      throw new Error(`task: proposal "${id}" consumption names run "${root.rootRunId}" in status "${run.status}"; a root run is consumed running`)
    }
    if (run.executionPhase !== 'active') {
      throw new Error(
        `task: proposal "${id}" consumption names run "${root.rootRunId}" with execution phase "${String(run.executionPhase)}"; a root run is born active`,
      )
    }
  }

  /**
   * The review context's closed shape. Its manifest fingerprint and every
   * verifier id/version/configuration are checked for the shapes that make them
   * comparable — a digest that is not a digest, or a verifier without an id,
   * would leave `reviewContextDigest` comparing values nobody can interpret —
   * and unknown fields are refused because the digest covers exactly the
   * declared surface: a field no reader understands must not move an identity.
   */
  private assertReviewContext(id: string, context: TaskProposalReviewContext): void {
    if (!isRecord(context)) throw new Error(`task: proposal "${id}" requires a review context`)
    for (const key of Object.keys(context)) {
      if (!REVIEW_CONTEXT_FIELDS.includes(key)) {
        throw new Error(`task: proposal "${id}" review context has an unsupported field "${key}"`)
      }
    }
    if (!isDigest(context.capabilityManifestDigest)) {
      throw new Error(`task: proposal "${id}" review context capability manifest digest must be a lowercase SHA-256 hex digest`)
    }
    if (!Array.isArray(context.verifiers)) throw new Error(`task: proposal "${id}" review context verifiers must be an array`)
    for (const verifier of context.verifiers) {
      if (!isRecord(verifier)) throw new Error(`task: proposal "${id}" review context verifiers must be objects`)
      for (const key of Object.keys(verifier)) {
        if (!VERIFIER_IDENTITY_FIELDS.includes(key)) {
          throw new Error(`task: proposal "${id}" review context verifier has an unsupported field "${key}"`)
        }
      }
      if (!nonEmpty(verifier.verifierId)) throw new Error(`task: proposal "${id}" review context verifier requires a verifier id`)
      if (verifier.version !== undefined && !nonEmpty(verifier.version)) {
        throw new Error(`task: proposal "${id}" review context verifier "${verifier.verifierId}" version must be a non-empty string when present`)
      }
      if (verifier.configurationDigest !== undefined && !isDigest(verifier.configurationDigest)) {
        throw new Error(
          `task: proposal "${id}" review context verifier "${verifier.verifierId}" configuration digest must be a lowercase SHA-256 hex digest when present`,
        )
      }
    }
  }

  private transit(taskId: TaskId, from: readonly TaskStatus[], to: TaskStatus): void {
    this.assertTransition(taskId, from, to)
    this.updateTask(taskId, { status: to })
  }

  private assertTransition(taskId: TaskId, from: readonly TaskStatus[], to: TaskStatus): void {
    const current = this.task(taskId)
    if (!from.includes(current.status)) {
      throw new Error(`task: illegal transition "${current.status}" → "${to}" for task "${taskId}"`)
    }
  }

  private assertRunTransition(runId: RunId, from: readonly RunStatus[], to: RunStatus): void {
    const current = this.run(runId)
    if (!from.includes(current.status)) {
      throw new Error(`task: illegal run transition "${current.status}" → "${to}" for run "${runId}"`)
    }
  }

  private setRun(runId: RunId, status: RunStatus, finishedAt?: string): void {
    this.value = {
      ...this.value,
      runs: this.value.runs.map(item => item.runId === runId
        ? { ...item, status, ...(finishedAt !== undefined ? { finishedAt } : {}) }
        : item),
    }
  }

  private updateTask(taskId: TaskId, patch: Partial<TaskInstance>): void {
    this.value = {
      ...this.value,
      tasks: this.value.tasks.map(item => item.taskId === taskId ? { ...item, ...patch } : item),
    }
  }

  private task(taskId: TaskId): TaskInstance {
    const task = this.value.tasks.find(item => item.taskId === taskId)
    if (task === undefined) throw new Error(`task: unknown task "${taskId}"`)
    return task
  }

  private run(runId: RunId): TaskRun {
    const run = this.value.runs.find(item => item.runId === runId)
    if (run === undefined) throw new Error(`task: unknown run "${runId}"`)
    return run
  }
}
