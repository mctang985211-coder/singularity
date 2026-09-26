/**
 * How the store's records read (A2 §D): the one place the contract, the run, the
 * evidence, the review and the diagnosis turn into text.
 *
 * These render functions are projections, not authorities. Every fact they print
 * comes from a snapshot of the store (or from the run binding's own snapshot
 * files, re-read and reported by name when they no longer match the record);
 * nothing is derived from a model's prompt, a tool argument, or an in-memory
 * cache. The shapes they print are the ones the tools and the prompt assembly
 * already read, so no second rendering of the same record can drift from this
 * one.
 * @module @dangosys/dsh-singularity-context/render
 */

import { blockingQuestionsOf } from '@dangosys/dsh-singularity-task'
import type {
  AcceptanceCriterion,
  ArtifactRef,
  Diagnosis,
  EvidenceBundle,
  ReviewRecord,
  RunProviderBinding,
  SubmissionRecord,
  TaskHandoff,
  TaskInstance,
  TaskRun,
  TaskSnapshot,
} from '@dangosys/dsh-singularity-task'
import type { ReadOnlyTaskRuntime } from './bindings.ts'
import { renderRunBinding } from './run-binding.ts'

/**
 * The full phase note: what a phase-less record is and what a reader can do
 * about it. A run created before the phase field existed has *no* phase, and its
 * phase is never guessed — a non-terminal such run is an old record whose only
 * legal continuation is cancellation, so reporting `active` for it would invite
 * work nobody can admit. Terminal records need no phase.
 */
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

/**
 * The phase one run's line shows (A4 §7.2, K1 §2): a run whose stored phase is
 * `active` while a blocking question it asked is still open reads
 * `waiting_answer` — a batch ending never answers that question, so the block
 * outlives the batch and shows here either way. The derivation is the store's own
 * question facts ({@link blockingQuestionsOf}) — never the gate, and never a
 * phase written back: `waiting_children` keeps its own phase and the batch id it
 * is waiting on beside any open question, and a run whose snapshot is not at hand
 * (or carries no question index) shows the phase it has on record.
 */
function displayPhase(run: TaskRun, snapshot: TaskSnapshot | undefined): string {
  const phase = run.executionPhase as string
  if (phase !== 'active') return phase
  return blockedByQuestion(run, snapshot) ? 'waiting_answer' : phase
}

/** Whether a blocking question this run asked is still open — the fact `waiting_answer` is derived from. */
function blockedByQuestion(run: TaskRun, snapshot: TaskSnapshot | undefined): boolean {
  return snapshot?.questions === undefined ? false : blockingQuestionsOf(snapshot, run.runId).length > 0
}

/**
 * The phase, batch, submission and no-progress facts of one run, appended to a
 * run line: where this run sits in the protocol, in that order, with the batch
 * id only where a batch is still open — `run.batchId` is the current unfinished
 * batch, cleared by the batch end that returned the run to `active`, so a run
 * back at work reads without one. The batches a run ended are its history rather
 * than its position: they are read from the run's own record (`run.batches`,
 * printed with it by {@link runRecordText}), not folded into every line. A phase
 * change and a progress marking rewrite these fields, so this is the run's
 * current position, never a history.
 *
 * `snapshot` is where the one derived word comes from: an `active` run with an
 * open blocking question reads `waiting_answer` (see {@link displayPhase}).
 */
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

/**
 * The protected acceptance inputs a criterion declares, as one suffix: the paths
 * a worker must not modify. Empty for a criterion that declares none — such a
 * criterion carries no protection, and printing an empty list would read like a
 * claim that it does.
 */
function protectedInputsPart(criterion: AcceptanceCriterion): string {
  const declared = criterion.protectedInputs ?? []
  return declared.length === 0 ? '' : ` [protected inputs: ${declared.map(ref => ref.path).join(', ')}]`
}

/** The protected inputs with their fixed identity, for a record read: the digest *is* part of the stored record. */
function protectedInputsDetail(criterion: AcceptanceCriterion): string[] {
  const declared = criterion.protectedInputs ?? []
  if (declared.length === 0) return []
  return ['  protected inputs:', ...declared.map(ref => `  - ${ref.path} (sha256 ${ref.sha256})`)]
}

/** The acceptance criteria, one line per criterion, in declaration order. */
export function criteriaLines(criteria: readonly AcceptanceCriterion[]): string[] {
  return criteria.map(criterion => {
    const command = criterion.command === undefined ? '' : ` — $ ${criterion.command}`
    const flags = [criterion.verificationMode, ...(criterion.mandatory ? ['mandatory'] : []), ...(criterion.heuristic === true ? ['heuristic'] : [])]
    return `- ${criterion.criterionId} [${flags.join(', ')}] ${criterion.description}${command}${protectedInputsPart(criterion)}`
  })
}

/**
 * The two contract facts a reader cannot read off the objective and the criteria
 * table: what the contract assumes and what it constrains. A task created before
 * the contract existed has neither, and renders exactly what it rendered before:
 * nothing is invented for the part the store never held.
 */
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
function artifactLine(artifact: ArtifactRef): string {
  const digest = artifact.digest === undefined ? '' : ` digest ${artifact.digest}`
  return `\`${artifact.artifactId}\` [${artifact.kind}] ${artifact.uri}${digest}`
}

/**
 * The run the caller (or a referenced run) is executing, as the store recorded
 * it: the providers this run was bound to, re-checked against the snapshot the
 * record names before they are shown.
 *
 * Why the re-check is not optional: the record says which bytes the run loaded,
 * and the snapshot path is the only place those bytes still exist. A snapshot
 * that is missing or edited is reported as such, naming the skill — the one
 * thing a read must never do is quietly show what stands at the production skill
 * path now, which would read as "this is what you are running".
 *
 * A run with no binding record, or one whose record names no snapshot, has
 * nothing to claim and renders nothing.
 */
export async function bindingLines(taskRuntime: ReadOnlyTaskRuntime, binding: RunProviderBinding | undefined): Promise<string[]> {
  if (binding === undefined) return []
  let summary: string
  try {
    summary = renderRunBinding(binding, await taskRuntime.readRunBinding(binding))
  } catch (error) {
    summary = [
      '## Implementation chosen for this run',
      '',
      `- bound content could not be re-read against its snapshot: ${error instanceof Error ? error.message : String(error)}`,
    ].join('\n')
  }
  return summary.length === 0 ? [] : ['', ...summary.split('\n')]
}

/**
 * The root most distant ancestor of one task: the top of its real parent chain,
 * which is what carries the objective and hard constraints a descendant works
 * under. `brokenAt` names the parent the walk stopped at when the store does not
 * hold it — a chain that leaves the store is reported, never filled in.
 */
export function rootAncestor(
  snapshot: TaskSnapshot,
  task: TaskInstance,
): { readonly task: TaskInstance; readonly brokenAt?: string } {
  const visited = new Set<string>([task.taskId])
  let current = task
  while (current.parentTaskId !== undefined) {
    const parentId = current.parentTaskId
    const parent = snapshot.tasks.find(item => item.taskId === parentId)
    if (parent === undefined) return { task: current, brokenAt: parentId }
    if (visited.has(parent.taskId)) return { task: current, brokenAt: parentId }
    visited.add(parent.taskId)
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

/**
 * The handoff envelope as a projection (A2 §D): the delegation terms, the
 * decided/assumed/open items, and the references a worker may read for itself.
 * The parent session is named as a `context_read` reference — the one session
 * entry this deployment offers — never as a raw cross-session tool.
 */
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

/* --- record renderings (the paginated `context_read` payloads) ----------- */

function jsonBlock(value: unknown): string[] {
  return ['```json', JSON.stringify(value, null, 2), '```']
}

/** The complete rendering of one task record. */
export function taskRecordText(task: TaskInstance): string {
  const contract = task.contract
  const lines: string[] = [
    `task ${task.taskId} [${task.status}/${task.decompositionStatus}] depth ${task.depth} ` +
      `taskType ${task.definitionRef.taskType}@${task.definitionRef.version}`,
    `parent: ${task.parentTaskId ?? '(none — this is a parentless record)'}`,
    `objective: ${task.objective}`,
  ]
  lines.push('acceptance criteria:', ...(task.acceptanceCriteria.length === 0 ? ['(none)'] : criteriaLines(task.acceptanceCriteria)))
  for (const criterion of task.acceptanceCriteria) {
    const extras: string[] = []
    if (criterion.requiredEvidence.length > 0) extras.push(`  required evidence: ${criterion.requiredEvidence.join(', ')}`)
    if (criterion.requiresArtifact !== undefined && criterion.requiresArtifact.length > 0) {
      extras.push(`  requires artifact: ${criterion.requiresArtifact.join(', ')}`)
    }
    if (criterion.acceptsArtifact !== undefined && criterion.acceptsArtifact.length > 0) {
      extras.push(`  accepts artifact: ${criterion.acceptsArtifact.join(', ')}`)
    }
    if (criterion.verifierRef !== undefined) extras.push(`  verifier: ${criterion.verifierRef}`)
    for (const child of criterion.childEvidence ?? []) {
      extras.push(
        `  child evidence: run member #${child.childIndex}` +
          `${child.criterionId === undefined ? '' : ` criterion ${child.criterionId}`}` +
          `${child.evidenceRef === undefined ? '' : ` ref ${child.evidenceRef}`}`,
      )
    }
    extras.push(...protectedInputsDetail(criterion))
    if (extras.length > 0) lines.push(...extras)
  }
  lines.push(`requested capabilities: ${task.requestedCapabilities.length === 0 ? '(none)' : task.requestedCapabilities.join(', ')}`)
  if (task.requiresIndependentAcceptance === true) lines.push('requires independent acceptance: yes')
  lines.push(...contractLines(task))
  if (contract !== undefined) lines.push(`contract version: ${contract.contractVersion}`)
  lines.push(`runs: ${task.runIds.length === 0 ? '(none)' : task.runIds.join(', ')}`)
  lines.push(`children: ${task.childTaskIds.length === 0 ? '(none)' : task.childTaskIds.join(', ')}`)
  return lines.join('\n')
}

/**
 * The complete rendering of one run record, with the binding re-check appended.
 * The snapshot is the store the run was read out of: it is where the one
 * derived word on the run line comes from (see {@link runPhaseSuffix}).
 */
export async function runRecordText(
  taskRuntime: ReadOnlyTaskRuntime,
  run: TaskRun,
  snapshot?: TaskSnapshot,
): Promise<string> {
  const { providerBinding, ...record } = run
  const lines: string[] = [
    `run ${run.runId} of task ${run.taskId} [${run.status}]${runPhaseSuffix(run, snapshot)}`,
    `session: ${run.sessionId}${run.parentRunId === undefined ? '' : ` · parent run: ${run.parentRunId}`}`,
    `started: ${run.startedAt}${run.finishedAt === undefined ? '' : ` · finished: ${run.finishedAt}`}`,
    `capabilities: ${run.capabilitySnapshot.length === 0 ? '(none)' : run.capabilitySnapshot.join(', ')}`,
    ...(run.agentPreset === undefined ? [] : [`agent preset: ${run.agentPreset}`]),
    'artifacts:',
    ...(run.artifacts.length === 0 ? ['(none)'] : run.artifacts.map(artifact => `- ${artifactLine(artifact)}`)),
    'verifier results:',
    ...(run.verifierResults.length === 0
      ? ['(none)']
      : run.verifierResults.map(
          result =>
            `- ${result.criterionId} [${result.status}] verifier ${result.verifierId}` +
            `${result.verifierVersion === undefined ? '' : ` v${result.verifierVersion}`}` +
            `${result.exitCode === undefined ? '' : ` exit ${result.exitCode}`}` +
            `${result.logRef === undefined ? '' : ` log ${result.logRef}`}`,
        )),
    '',
    'recorded fields:',
    ...jsonBlock(record),
  ]
  lines.push(...await bindingLines(taskRuntime, providerBinding))
  return lines.join('\n')
}

/** The complete rendering of one evidence bundle. */
export function evidenceRecordText(snapshot: TaskSnapshot, evidence: EvidenceBundle): string {
  return [
    `evidence ${evidence.evidenceId} of task ${evidence.taskId} (run ${evidence.taskRunId}), generated ${evidence.generatedAt}`,
    '',
    ...jsonBlock(evidence),
    '',
    `run state: ${snapshot.runs.find(run => run.runId === evidence.taskRunId)?.status ?? '(the run this evidence names is not in this store)'}`,
  ].join('\n')
}

/**
 * The complete rendering of one review record. A record is identified by its
 * `(taskId, runId)` pair — a review has no id of its own — so the pair is
 * printed first, and a task that settled before any run started says so instead
 * of printing an invented run id.
 */
export function reviewRecordText(review: ReviewRecord): string {
  const runPart = review.runId === undefined ? 'no run — the task blocked before any run started' : `run ${review.runId}`
  return [
    `review of task ${review.taskId} (${runPart}) [${review.outcome}]`,
    `evidence refs: ${review.evidenceRefs.length === 0 ? '(none)' : review.evidenceRefs.join(', ')}`,
    '',
    ...jsonBlock(review),
  ].join('\n')
}

/** The complete rendering of one diagnosis record. */
export function diagnosisRecordText(diagnosis: Diagnosis): string {
  return [
    `diagnosis ${diagnosis.diagnosisId} of task ${diagnosis.taskId} [confidence ${diagnosis.confidence}]`,
    `observed failure: ${diagnosis.observedFailure}`,
    `localized cause: ${diagnosis.localizedCause}`,
    '',
    ...jsonBlock(diagnosis),
  ].join('\n')
}

/**
 * The one-line identity of one task, in the shape both status reads use: status,
 * objective, the latest run with its phase, evidence ids, the most recent review
 * outcome with the detail a reader can act on, and the diagnosis count.
 *
 * The phase cell is derived from this same snapshot, so a related task's own
 * open blocking question shows as `waiting_answer` here too.
 */
export function taskSummaryLine(snapshot: TaskSnapshot, task: TaskInstance, roles: readonly string[] = []): string {
  const run = latestRun(snapshot, task)
  const evidence = snapshot.evidence.filter(item => item.taskId === task.taskId).map(item => item.evidenceId)
  const review = [...snapshot.reviews].reverse().find(item => item.taskId === task.taskId)
  const diagnoses = snapshot.diagnoses.filter(item => item.taskId === task.taskId).length
  const runPart = run === undefined ? 'run: none' : `run: ${run.status}${runPhaseCell(run, snapshot)}`
  const evidencePart = evidence.length === 0 ? '' : ` evidence: [${evidence.join(', ')}]`
  const failing = review?.criteria?.filter(item => item.verdict !== 'pass') ?? []
  const detail = review?.outcome === 'failed' && failing.length > 0
    ? `${review.localizedCause ?? 'failed'} [${failing.map(item => `${item.criterionId}${item.exitCode === undefined ? '' : ` exit ${item.exitCode}`}`).join(', ')}]`
    : review?.localizedCause ?? review?.anomalies[0]
  const reviewPart = review === undefined ? '' : ` review: ${review.outcome}${detail === undefined ? '' : ` — ${detail}`}`
  const diagPart = diagnoses === 0 ? '' : ` diag: ${diagnoses}`
  const rolePart = roles.length === 0 ? '' : ` [${roles.join(', ')}]`
  return `- ${task.taskId} [${task.status}] ${task.objective} (${runPart}${evidencePart}${reviewPart}${diagPart})${rolePart}`
}
