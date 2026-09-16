import type {
  DependencyEdge,
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

export class TaskState {
  private value: TaskSnapshot

  constructor(id: string, snapshot?: TaskSnapshot) {
    this.value = snapshot === undefined
      ? { version: 1, id, tasks: [], runs: [], edges: [], evidence: [], handoffs: [], capabilities: {} }
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
    if (edge.from === edge.to || this.reaches(edge.to, edge.from)) {
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

  private reaches(start: TaskId, target: TaskId): boolean {
    const seen = new Set<TaskId>()
    const pending = [start]
    while (pending.length > 0) {
      const current = pending.pop() as TaskId
      if (current === target) return true
      if (seen.has(current)) continue
      seen.add(current)
      for (const edge of this.value.edges) if (edge.from === current) pending.push(edge.to)
    }
    return false
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
