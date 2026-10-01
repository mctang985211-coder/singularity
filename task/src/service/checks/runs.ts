/** Run-record shape checks: provider binding, submission, birth phase, legacy question ids, recovery. @module @dangosys/dsh-singularity-task/service/checks/runs */

import type { QuestionMessageRef } from '../../question.ts'
import type {
  RunId,
  RunProviderBinding,
  RunRecovery,
  SubmissionRecord,
  TaskEventPayloads,
  TaskId,
  TaskRun,
  TaskSnapshot,
} from '../../types.ts'
import { runMemberSlots } from '../../types.ts'
import { isDigest, isRecord, nonEmpty, taskIn } from './primitives.ts'

/** The content identity a run records is what a later reader re-checks the snapshot against, so a malformed record is refused rather than stored: a digest that is not a digest, or a skill entry without a name, would make the record unusable … */
export function assertProviderBinding(runId: RunId, binding: RunProviderBinding): void {
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
    if (!isDigest(value)) {
      throw new Error(
        `task: run "${runId}" provider binding ${where} must be a lowercase SHA-256 hex digest${nullable ? ' or null' : ''}`,
      )
    }
  }
  for (const entry of list('skills', binding.skills)) {
    if (!isRecord(entry)) throw new Error(`task: run "${runId}" provider binding skill entries must be objects`)
    if (typeof entry.name !== 'string' || entry.name.length === 0) {
      throw new Error(`task: run "${runId}" provider binding skill requires a name`)
    }
    if (entry.role !== 'execution-provider' && entry.role !== 'knowledge' && entry.role !== 'guidance') {
      throw new Error(
        `task: run "${runId}" provider binding skill "${entry.name}" has an unknown role ${JSON.stringify(entry.role)}`,
      )
    }
    if (typeof entry.description !== 'string') {
      throw new Error(`task: run "${runId}" provider binding skill "${entry.name}" requires a description`)
    }
    const capabilities: unknown = entry.capabilities
    if (!Array.isArray(capabilities) || capabilities.some(item => typeof item !== 'string')) {
      throw new Error(
        `task: run "${runId}" provider binding skill "${entry.name}" capabilities must be an array of strings`,
      )
    }
    const uncovered: unknown = entry.uncovered
    if (!Array.isArray(uncovered) || uncovered.some(item => typeof item !== 'string')) {
      throw new Error(
        `task: run "${runId}" provider binding skill "${entry.name}" uncovered must be an array of strings`,
      )
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
  if (
    binding.snapshotRoot !== undefined &&
    (typeof binding.snapshotRoot !== 'string' || binding.snapshotRoot.length === 0)
  ) {
    throw new Error(`task: run "${runId}" provider binding snapshotRoot must be a non-empty path when present`)
  }
}

/** The submission record is what a reader trusts instead of re-reading the worker's transcript, so a malformed one is refused rather than stored: an unnamed summary or a ref list that is not a list would leave the record unusable exactly when … */
export function assertSubmissionShape(runId: RunId, submission: SubmissionRecord): void {
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

/** A run's birth phase is written by the runtime, and the reducer judges its shape only — the transition semantics belong to `changeRunPhase`. */
export function assertBirthPhase(run: TaskRun): void {
  const phase = run.executionPhase
  if (phase === undefined) return
  if (phase !== 'active' && phase !== 'submitted') {
    throw new Error(`task: run "${run.runId}" execution phase must be "active" or "submitted" at start`)
  }
  if (run.batchId !== undefined) {
    throw new Error(`task: run "${run.runId}" is born ${phase}; a batch id is recorded by a phase change, not at start`)
  }
  if (run.batches !== undefined) {
    throw new Error(
      `task: run "${run.runId}" is born ${phase}; a run's batches are recorded by the decompositions it admits, not at start`,
    )
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
  assertSubmissionShape(run.runId, run.submission)
}

/** The A3 question-id mount points ride on a phase change and are read-only since A4: the question records are the one durable source of what a run waits on, and this build's write entries refuse a phase change that carries either field. */
export function assertQuestionIds(runId: RunId, payload: TaskEventPayloads['RunPhaseChanged']): void {
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

/** A cited body reference: the sending Session, and a seq inside its log. */
export function assertMessageRef(where: string, ref: QuestionMessageRef): void {
  if (!isRecord(ref)) throw new Error(`task: ${where} body reference must be an object`)
  if (!nonEmpty(ref.sessionId)) throw new Error(`task: ${where} body reference session id must be a non-empty string`)
  if (!Number.isInteger(ref.seq) || ref.seq < 0)
    throw new Error(`task: ${where} body reference seq must be a non-negative integer`)
}

/** The recovery attempt a run carries (A6, plan §F.4), judged by the reducer as the last gate — the entry re-checks the same facts against policy (the source's failure, the diagnosis, the limits, the capability rows), and this accepts only a … */
export function assertRunRecovery(snapshot: TaskSnapshot, taskId: TaskId, recovery: RunRecovery): void {
  const where = `task: run recovery of "${taskId}"`
  for (const [name, value] of [
    ['source diagnosis id', recovery.sourceDiagnosisId],
    ['request key', recovery.requestKey],
    ['requested at', recovery.requestedAt],
  ] as const) {
    if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${where} requires a non-empty ${name}`)
  }
  if (
    recovery.sourceRunId !== undefined &&
    (typeof recovery.sourceRunId !== 'string' || recovery.sourceRunId.length === 0)
  ) {
    throw new Error(`${where} source run id must be a non-empty string when present`)
  }
  if (
    recovery.requestDigest !== undefined &&
    (typeof recovery.requestDigest !== 'string' || recovery.requestDigest.trim().length === 0)
  ) {
    throw new Error(`${where} request digest must be a non-empty string when present`)
  }
  const task = taskIn(snapshot, taskId)
  if (task.parentTaskId !== undefined) {
    throw new Error(
      `${where} names task "${taskId}", which has a parent; a recovery attempt is opened for the store's own root task`,
    )
  }
  if (
    !snapshot.diagnoses.some(
      diagnosis => diagnosis.diagnosisId === recovery.sourceDiagnosisId && diagnosis.taskId === taskId,
    )
  ) {
    throw new Error(
      `${where} cites diagnosis "${recovery.sourceDiagnosisId}", which this store holds no record of for task "${taskId}"; ` +
        'a recovery is asked for by a diagnosis of the failing task and by nothing else',
    )
  }
  let sourceRun: TaskRun | undefined
  if (recovery.sourceRunId !== undefined) {
    sourceRun = snapshot.runs.find(run => run.runId === recovery.sourceRunId)
    if (sourceRun === undefined) throw new Error(`${where} cites unknown run "${recovery.sourceRunId}"`)
    if (sourceRun.taskId !== taskId) {
      throw new Error(
        `${where} cites run "${recovery.sourceRunId}", which belongs to task "${sourceRun.taskId}", not "${taskId}"`,
      )
    }
  }
  const reused = recovery.reusedMembers
  if (!Array.isArray(reused)) throw new Error(`${where} reused members must be an array`)
  const claimed = new Set<number>()
  reused.forEach((member, position) => {
    const at = `${where} reused member ${position}`
    if (!isRecord(member)) throw new Error(`${at} must be an object`)
    if (!Number.isInteger(member.childIndex) || (member.childIndex as number) < 0) {
      throw new Error(`${at} childIndex ${JSON.stringify(member.childIndex)} must be a non-negative integer`)
    }
    if (claimed.has(member.childIndex as number)) {
      throw new Error(
        `${at} claims position ${member.childIndex}, which another entry of this record already claims; one position reads one member`,
      )
    }
    claimed.add(member.childIndex as number)
    if (sourceRun !== undefined && runMemberSlots(sourceRun)[member.childIndex as number] !== member.taskId) {
      throw new Error(
        `${at} claims position ${member.childIndex} for "${String(member.taskId)}", but the failed run "${sourceRun.runId}" reads ` +
          `${runMemberSlots(sourceRun)[member.childIndex as number] === undefined ? 'no member' : `"${runMemberSlots(sourceRun)[member.childIndex as number]}"`} there`,
      )
    }
    const sibling = snapshot.tasks.find(candidate => candidate.taskId === member.taskId)
    if (sibling === undefined) throw new Error(`${at} cites unknown task "${String(member.taskId)}"`)
    if (sibling.parentTaskId !== taskId) {
      throw new Error(
        `${at} cites task "${sibling.taskId}", which is not a child of "${taskId}"; only a sibling of the failed attempt can be reused`,
      )
    }
    if (sibling.status !== 'verified') {
      throw new Error(
        `${at} cites task "${sibling.taskId}", which is ${sibling.status}, not verified; only evidence of a passed sibling is reusable`,
      )
    }
    const source = snapshot.runs.find(run => run.runId === member.sourceRunId)
    if (source === undefined) throw new Error(`${at} cites unknown run "${String(member.sourceRunId)}"`)
    if (source.taskId !== sibling.taskId) {
      throw new Error(
        `${at} cites run "${source.runId}", which belongs to task "${source.taskId}", not "${sibling.taskId}"`,
      )
    }
    if (source.status !== 'verified') {
      throw new Error(
        `${at} cites run "${source.runId}", which is ${source.status}; a reused member reads the evidence of a verified run`,
      )
    }
    const bundle = snapshot.evidence.find(item => item.evidenceId === member.evidenceId)
    if (bundle === undefined) throw new Error(`${at} cites unknown evidence "${String(member.evidenceId)}"`)
    if (bundle.taskRunId !== source.runId || bundle.taskId !== sibling.taskId) {
      throw new Error(
        `${at} cites evidence "${bundle.evidenceId}", which belongs to task "${bundle.taskId}"/run "${bundle.taskRunId}", ` +
          `not to "${sibling.taskId}"/"${source.runId}"`,
      )
    }
    const named = new Set(bundle.artifacts.flatMap(artifact => [artifact.artifactId, artifact.kind]))
    for (const reference of member.artifactRefs ?? []) {
      if (!named.has(reference)) {
        throw new Error(
          `${at} cites artifact "${String(reference)}", which the evidence "${bundle.evidenceId}" does not hold (by artifact id or kind)`,
        )
      }
    }
    if (member.criterionId !== undefined) {
      const criterion = sibling.acceptanceCriteria.find(item => item.criterionId === member.criterionId)
      if (criterion === undefined) {
        throw new Error(
          `${at} names criterion "${member.criterionId}", which the sibling "${sibling.taskId}" does not declare`,
        )
      }
      const verdict = bundle.verifierResults.find(item => item.criterionId === member.criterionId)
      if (verdict?.status !== 'pass') {
        throw new Error(
          `${at} names criterion "${member.criterionId}" of sibling "${sibling.taskId}", whose verified evidence carries ` +
            `${verdict === undefined ? 'no verdict' : `a "${verdict.status}" verdict`}; only a passing verdict is reusable`,
        )
      }
    }
    const declaredInputs = new Set(
      sibling.acceptanceCriteria.flatMap(criterion => [
        ...(criterion.requiresArtifact ?? []),
        ...(criterion.acceptsArtifact ?? []),
        ...(criterion.protectedInputs ?? []).map(input => input.path),
      ]),
    )
    for (const reference of member.inputRefs ?? []) {
      if (!declaredInputs.has(reference)) {
        throw new Error(
          `${at} cites input "${String(reference)}", which the sibling "${sibling.taskId}" does not declare ` +
            '(requiresArtifact, acceptsArtifact or protectedInputs)',
        )
      }
    }
    const mapEntry = task.acceptanceCriteria
      .flatMap(criterion => criterion.childEvidence ?? [])
      .find(entry => entry.childIndex === member.childIndex)
    if (mapEntry !== undefined) {
      if (mapEntry.criterionId !== undefined && mapEntry.criterionId !== member.criterionId) {
        throw new Error(
          `${at} claims position ${member.childIndex}, which the original acceptance map narrows to criterion "${mapEntry.criterionId}"; ` +
            `this record ${member.criterionId === undefined ? 'names no criterion' : `names "${member.criterionId}"`}`,
        )
      }
      if (
        mapEntry.evidenceRef !== undefined &&
        member.evidenceId !== mapEntry.evidenceRef &&
        !(member.artifactRefs ?? []).includes(mapEntry.evidenceRef)
      ) {
        throw new Error(
          `${at} claims position ${member.childIndex}, which the original acceptance map narrows to evidence "${mapEntry.evidenceRef}"; ` +
            'the cited bundle does not carry that identity (evidence id, artifact id or artifact kind)',
        )
      }
    }
  })
  const unbound = recovery.unboundMembers
  if (unbound !== undefined) {
    if (!Array.isArray(unbound)) throw new Error(`${where} unbound members must be an array`)
    for (const [position, entry] of unbound.entries()) {
      const at = `${where} unbound member ${position}`
      if (!isRecord(entry)) throw new Error(`${at} must be an object`)
      if (!Number.isInteger(entry.childIndex) || (entry.childIndex as number) < 0) {
        throw new Error(`${at} childIndex ${JSON.stringify(entry.childIndex)} must be a non-negative integer`)
      }
      if (
        !Array.isArray(entry.reasons) ||
        entry.reasons.length === 0 ||
        entry.reasons.some(reason => typeof reason !== 'string' || reason.trim().length === 0)
      ) {
        throw new Error(
          `${at} must carry at least one non-empty reason; a position left unbound is a finding, never a silent omission`,
        )
      }
      if (claimed.has(entry.childIndex as number)) {
        throw new Error(
          `${at} names position ${entry.childIndex}, which this record also claims; a position is either bound or left open`,
        )
      }
    }
  }
}
