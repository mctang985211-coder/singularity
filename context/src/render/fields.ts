/** How the store's fields read: phases, criteria, contracts, handoffs, summary lines. @module @dangosys/dsh-singularity-context/render-fields */

import { blockingQuestionsOf } from '@dangosys/dsh-singularity-task'
import type {
  AcceptanceCriterion,
  ArtifactRef,
  SubmissionRecord,
  TaskHandoff,
  TaskInstance,
  TaskRun,
  TaskSnapshot,
} from '@dangosys/dsh-singularity-task'

/** The full phase note: a phase-less run is an old record whose only continuation is cancellation. */
const NEEDS_RECOVERY =
  'needs-recovery (an old record: it was created before coordination phases, so it has no phase to continue from and cannot ' +
  'decompose, submit or verify — cancel this task tree to recover)'

/** The compact form, for a status line whose run part is a cell inside a denser line. */
const NEEDS_RECOVERY_SHORT = 'needs-recovery (old record without a coordination phase)'

/** The submission a run carries, as one clause: who handed it in, when, and what it named. */
function submissionClause(submission: SubmissionRecord): string {
  const evidence = submission.evidenceRefs.length === 0 ? '' : `; evidence [${submission.evidenceRefs.join(', ')}]`
  const notes = submission.notes === undefined ? '' : `; notes: ${submission.notes}`
  return `submitted by ${submission.origin} at ${submission.submittedAt}: "${submission.summary}"${evidence}${notes}`
}

/** The phase one run's line shows: `active` with an open blocking question reads `waiting_answer`. */
function displayPhase(run: TaskRun, snapshot: TaskSnapshot | undefined): string {
  const phase = run.executionPhase as string
  if (phase !== 'active') return phase
  return blockedByQuestion(run, snapshot) ? 'waiting_answer' : phase
}

/** Whether a blocking question this run asked is still open — the fact `waiting_answer` is derived from. */
function blockedByQuestion(run: TaskRun, snapshot: TaskSnapshot | undefined): boolean {
  return snapshot?.questions === undefined ? false : blockingQuestionsOf(snapshot, run.runId).length > 0
}

/** The phase, batch, submission and no-progress facts of one run, appended to a run line. */
export function runPhaseSuffix(run: TaskRun, snapshot?: TaskSnapshot): string {
  const parts: string[] = []
  if (run.executionPhase !== undefined) {
    parts.push(`phase ${displayPhase(run, snapshot)}`)
    if (run.batchId !== undefined) parts.push(`batch ${run.batchId}`)
    if (run.submission !== undefined) parts.push(submissionClause(run.submission))
  } else if (run.status === 'running') {
    parts.push(NEEDS_RECOVERY)
  }
  if (run.noProgress !== undefined) parts.push(`no-progress round ${run.noProgress.rounds} (${run.noProgress.kind})`)
  return parts.length === 0 ? '' : ` — ${parts.join('; ')}`
}

/** The same fact for a denser line, where only the phase and the old-record marker fit. */
export function runPhaseCell(run: TaskRun, snapshot?: TaskSnapshot): string {
  if (run.executionPhase !== undefined) return ` — phase ${displayPhase(run, snapshot)}`
  return run.status === 'running' ? ` — ${NEEDS_RECOVERY_SHORT}` : ''
}

/** The protected acceptance inputs a criterion declares, as one suffix. */
function protectedInputsPart(criterion: AcceptanceCriterion): string {
  const declared = criterion.protectedInputs ?? []
  return declared.length === 0 ? '' : ` [protected inputs: ${declared.map(ref => ref.path).join(', ')}]`
}

/** The protected inputs with their fixed identity, for a record read: the digest is part of the record. */
export function protectedInputsDetail(criterion: AcceptanceCriterion): string[] {
  const declared = criterion.protectedInputs ?? []
  if (declared.length === 0) return []
  return ['  protected inputs:', ...declared.map(ref => `  - ${ref.path} (sha256 ${ref.sha256})`)]
}

/** The acceptance criteria, one line per criterion, in declaration order. */
export function criteriaLines(criteria: readonly AcceptanceCriterion[]): string[] {
  return criteria.map(criterion => {
    const command = criterion.command === undefined ? '' : ` — $ ${criterion.command}`
    const flags = [
      criterion.verificationMode,
      ...(criterion.mandatory ? ['mandatory'] : []),
      ...(criterion.heuristic === true ? ['heuristic'] : []),
    ]
    return `- ${criterion.criterionId} [${flags.join(', ')}] ${criterion.description}${command}${protectedInputsPart(criterion)}`
  })
}

/** The two contract facts a reader cannot read off the objective and the criteria table. */
export function contractLines(task: TaskInstance): string[] {
  const contract = task.contract
  if (contract === undefined) return []
  return [
    ...(contract.assumptions.length === 0 ? [] : ['assumptions:', ...contract.assumptions.map(item => `- ${item}`)]),
    ...(contract.constraints.length === 0 ? [] : ['constraints:', ...contract.constraints.map(item => `- ${item}`)]),
  ]
}

/** One contract list on its own — the hard constraints a root briefing carries, or its assumptions. */
export function constraintItems(task: TaskInstance): readonly string[] {
  return task.contract?.constraints ?? []
}

/** One artifact reference, as the store holds it. */
export function artifactLine(artifact: ArtifactRef): string {
  const digest = artifact.digest === undefined ? '' : ` digest ${artifact.digest}`
  return `\`${artifact.artifactId}\` [${artifact.kind}] ${artifact.uri}${digest}`
}

/** The root most distant ancestor of one task: the top of its real parent chain. */
export function rootAncestor(
  snapshot: TaskSnapshot,
  task: TaskInstance,
): { readonly task: TaskInstance; readonly brokenAt?: string } {
  let current = task
  while (current.parentTaskId !== undefined) {
    const parentId = current.parentTaskId
    const parent = snapshot.tasks.find(item => item.taskId === parentId)
    if (parent === undefined) return { task: current, brokenAt: parentId }
    current = parent
  }
  return { task: current }
}

/** The latest run a task started, by the store's own run order. */
export function latestRun(snapshot: TaskSnapshot, task: TaskInstance): TaskRun | undefined {
  let found: TaskRun | undefined
  for (const runId of task.runIds) {
    const run = snapshot.runs.find(item => item.runId === runId)
    if (run !== undefined) found = run
  }
  return found
}

/** The handoff a task was delegated with, when a parent recorded one. */
export function handoffFor(snapshot: TaskSnapshot, taskId: string): TaskHandoff | undefined {
  let found: TaskHandoff | undefined
  for (const handoff of snapshot.handoffs) if (handoff.childTaskId === taskId) found = handoff
  return found
}

/** The handoff envelope as a projection: the delegation terms and the references a worker may read. */
export function handoffLines(handoff: TaskHandoff): string[] {
  const field = (title: string, items: readonly string[]): string[] =>
    items.length === 0 ? [`- ${title}: (none)`] : [`- ${title}:`, ...items.map(item => `  - ${item}`)]
  return [
    `- parent task: ${handoff.parentTaskId} (run ${handoff.parentRunId})`,
    `- parent objective: ${handoff.parentObjective}`,
    `- reason for delegation: ${handoff.reasonForDelegation}`,
    ...field('constraints', handoff.constraints),
    ...field('decisions already made', handoff.decisions),
    ...field('assumptions', handoff.assumptions),
    ...field('open questions', handoff.openQuestions),
    ...(handoff.parentSessionRef === undefined
      ? []
      : [
          `- the session that delegated this task is \`${handoff.parentSessionRef}\`; read it with ` +
            `\`context_read\` kind:"session" ref:"${handoff.parentSessionRef}"`,
        ]),
  ]
}

/** The reference lists a handoff carries, as their own lines: what to read for itself. */
export function handoffReferences(handoff: TaskHandoff): { readonly artifacts: string[]; readonly evidence: string[] } {
  return {
    artifacts: handoff.relevantArtifacts.map(artifact => `- ${artifactLine(artifact)}`),
    evidence: handoff.relevantEvidence.map(evidenceId => `- evidence \`${evidenceId}\``),
  }
}

/** The one-line identity of one task, in the shape both status reads use. */
export function taskSummaryLine(snapshot: TaskSnapshot, task: TaskInstance, roles: readonly string[] = []): string {
  const run = latestRun(snapshot, task)
  const evidence = snapshot.evidence.filter(item => item.taskId === task.taskId).map(item => item.evidenceId)
  const review = [...snapshot.reviews].reverse().find(item => item.taskId === task.taskId)
  const diagnoses = snapshot.diagnoses.filter(item => item.taskId === task.taskId).length
  const runPart = run === undefined ? 'run: none' : `run: ${run.status}${runPhaseCell(run, snapshot)}`
  const evidencePart = evidence.length === 0 ? '' : ` evidence: [${evidence.join(', ')}]`
  const failing = review?.criteria?.filter(item => item.verdict !== 'pass') ?? []
  const detail =
    review?.outcome === 'failed' && failing.length > 0
      ? `${review.localizedCause ?? 'failed'} [${failing.map(item => `${item.criterionId}${item.exitCode === undefined ? '' : ` exit ${item.exitCode}`}`).join(', ')}]`
      : (review?.localizedCause ?? review?.anomalies[0])
  const reviewPart =
    review === undefined ? '' : ` review: ${review.outcome}${detail === undefined ? '' : ` — ${detail}`}`
  const diagPart = diagnoses === 0 ? '' : ` diag: ${diagnoses}`
  const rolePart = roles.length === 0 ? '' : ` [${roles.join(', ')}]`
  return `- ${task.taskId} [${task.status}] ${task.objective} (${runPart}${evidencePart}${reviewPart}${diagPart})${rolePart}`
}

/** The heading the contract of each role is printed under. */
export function contractHeading(role: 'worker' | 'root' | 'reviewer' | 'replay'): string {
  switch (role) {
    case 'reviewer':
      return '## Delegated contract (review-only)'
    case 'root':
      return '## Your contract (graph root)'
    default:
      return '## Your contract'
  }
}

/** The contract block both the projection and `task_read` print, one shape for every role. */
export function contractBody(task: TaskInstance): string[] {
  return [
    `task ${task.taskId} [${task.status}/${task.decompositionStatus}] depth ${task.depth}`,
    `objective: ${task.objective}`,
    'acceptance criteria:',
    ...(task.acceptanceCriteria.length === 0 ? ['(none)'] : criteriaLines(task.acceptanceCriteria)),
    ...contractLines(task),
  ]
}

/** The caller's own run, as one line: status, phase, and the old-record marker such a run earns. */
export function ownRunLine(run: TaskRun, snapshot?: TaskSnapshot): string {
  return `run ${run.runId} [${run.status}]${runPhaseSuffix(run, snapshot)} started ${run.startedAt}`
}
