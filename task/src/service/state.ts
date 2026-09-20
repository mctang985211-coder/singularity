import { JUDGED_DIMENSIONS, JUDGEMENT_VERDICTS, reaches } from '../types.ts'
import type {
  DependencyEdge,
  Diagnosis,
  Obligation,
  ProposalTargetType,
  ReviewRecord,
  RunId,
  RunStatus,
  TaskEvent,
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

const PROPOSAL_TARGET_TYPES: readonly ProposalTargetType[] = [
  'skill', 'tool', 'capability', 'task_definition', 'decomposition_policy',
  'agent_preset', 'workflow_policy', 'verifier', 'runtime_policy',
]

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

export class TaskState {
  private value: TaskSnapshot

  constructor(id: string, snapshot?: TaskSnapshot) {
    this.value = snapshot === undefined
      ? { version: 1, id, tasks: [], runs: [], edges: [], evidence: [], handoffs: [], reviews: [], diagnoses: [], obligations: [], capabilities: {} }
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
      case 'TaskDecomposed': this.decompose(event.taskId, event.payload.childTaskIds); return
      case 'DependencyAdded': this.addDependency(event.payload.edge); return
      case 'TaskStarted': this.start(event.taskId, event.runId, event.payload.run); return
      case 'TaskBlocked': this.block(event.taskId, event.runId); return
      case 'TaskVerifying': this.transit(event.taskId, ['running'], 'verifying'); return
      case 'TaskVerified': this.verify(event.taskId, event.runId, event.payload.finishedAt); return
      case 'TaskFailed': this.fail(event.taskId, event.runId, event.payload.finishedAt); return
      case 'TaskCancelled': this.cancel(event.taskId, event.runId, event.payload.finishedAt); return
      case 'TaskRetried': this.transit(event.taskId, ['failed'], 'ready'); return
      case 'CapabilityResolved': this.resolveCapabilities(event.taskId, event.payload.manifest); return
      case 'CapabilityGapDetected': this.task(event.taskId); return
      case 'EvidenceProduced': this.produceEvidence(event.taskId, event.runId, event.payload.evidence); return
      case 'HandoffCreated': this.addHandoff(event.payload.handoff); return
      case 'ReviewRecorded': this.recordReview(event.taskId, event.runId, event.payload.review); return
      case 'DiagnosisRecorded': this.recordDiagnosis(event.taskId, event.payload.diagnosis); return
      case 'ObligationRecorded': this.recordObligation(event.payload.obligation); return
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

  private admit(taskId: TaskId, decompositionStatus: 'leaf' | 'decomposable'): void {
    this.assertTransition(taskId, ['created'], 'admitted')
    this.updateTask(taskId, { status: 'admitted', decompositionStatus })
  }

  private decompose(taskId: TaskId, childTaskIds: readonly TaskId[]): void {
    const parent = this.task(taskId)
    if (parent.decompositionStatus === 'decomposed') throw new Error(`task: task "${taskId}" is already decomposed`)
    for (const childTaskId of childTaskIds) {
      if (!parent.childTaskIds.includes(childTaskId)) throw new Error(`task: task "${childTaskId}" is not a child of "${taskId}"`)
    }
    const admitted = parent.childTaskIds.filter(childTaskId => ADMITTED_OR_LATER.includes(this.task(childTaskId).status))
    if (admitted.length === 0) throw new Error(`task: task "${taskId}" cannot decompose without an admitted child`)
    this.updateTask(taskId, { decompositionStatus: 'decomposed' })
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

  private cancel(taskId: TaskId, runId: RunId | undefined, finishedAt: string | undefined): void {
    this.assertTransition(taskId, ['running'], 'cancelled')
    if (runId !== undefined) this.assertRunTransition(runId, ['running', 'blocked'], 'cancelled')
    this.updateTask(taskId, { status: 'cancelled' })
    if (runId !== undefined) this.setRun(runId, 'cancelled', finishedAt)
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
